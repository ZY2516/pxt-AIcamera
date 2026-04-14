//% color=#1C7ED6 icon="\uf030" block="AIcamera"
namespace AIcamera {
    const UDEV_DEVICE_ADDR_DEFAULT = 0x60;

    const UDEV_FRAME_HEAD = 0xAA;
    const UDEV_CMD_WRITE_REG = 0x20;
    const UDEV_CMD_READ_REG = 0x21;
    const UDEV_CMD_UART_TUNNEL = 0x30;

    const UART_FRAME_HEAD_0 = 0xFF;
    const UART_FRAME_HEAD_1 = 0xF9;

    const UART_CMD_RGB_CONTROL = 0x30;
    const UART_CMD_SOUND_TOUCH_PATH = 0x37;
    const UART_CMD_SOUND_TOUCH_CTRL = 0x38;
    const UART_CMD_SOUND_TOUCH_UPLOAD = 0x3A;

    const REG_APP_ID = 0;
    const REG_RESULT_BASE = 100;

    const SOUND_CTRL_CMD_START = 0x01;
    const SOUND_CTRL_CMD_STOP = 0x02;

    let deviceAddr = UDEV_DEVICE_ADDR_DEFAULT;

    let ioChunk = 10;
    let ioGapMs = 10;

    let faceStatusCache = 0;
    let faceIdCache = 0;
    let faceSimilarityCache = 0;
    let faceBlinkCache = 0;
    let faceMouthOpenCache = 0;
    let faceLabelCache = "";

    let selfLearnStatusCache = 0;
    let selfLearnIdCache = 0;
    let selfLearnSimilarityCache = 0;
    let selfLearnLabelCache = "";

    let handStatusCache = 0;
    let handIdCache = 0;
    let handSimilarityCache = 0;
    let handPoseSimilarityCache = 0;
    let handLabelCache = "";

    let soundTouchStatusCache = 0;
    let soundTouchBpmCache = 0;
    let soundTouchBeatCountCache = 0;
    let soundTouchDurationSecCache = 0;
    let soundTouchMessageCache = "";

    export enum AppMode {
        //% block="launcher"
        Launcher = 0x01,
        //% block="face recognize"
        FaceRecognize = 0x10,
        //% block="self learn"
        SelfLearn = 0x11,
        //% block="hand recognize"
        HandRecognize = 0x12,
        //% block="remote file manager"
        RemoteFileManager = 0x13,
        //% block="photos"
        Photos = 0x14,
        //% block="camera"
        Camera = 0x15,
        //% block="settings"
        Settings = 0x16,
        //% block="sound touch"
        SoundTouch = 0x1B,
    }

    export enum RgbColor {
        //% block="off"
        Off = 0,
        //% block="red"
        Red = 1,
        //% block="green"
        Green = 2,
        //% block="blue"
        Blue = 3,
        //% block="yellow"
        Yellow = 4,
        //% block="cyan"
        Cyan = 5,
        //% block="purple"
        Purple = 6,
        //% block="white"
        White = 7,
    }

    export enum SoundState {
        //% block="idle"
        Idle = 0,
        //% block="result ready"
        ResultReady = 1,
        //% block="recording"
        Recording = 2,
        //% block="processing"
        Processing = 3,
        //% block="state 4"
        State4 = 4,
    }

    let currentMode: AppMode = AppMode.Launcher;

    function minNumber(a: number, b: number): number {
        return a < b ? a : b;
    }

    function maxNumber(a: number, b: number): number {
        return a > b ? a : b;
    }

    function clampByte(v: number): number {
        let x = v | 0;
        if (x < 0) {
            x = 0;
        }
        if (x > 255) {
            x = 255;
        }
        return x;
    }

    function normalizeAddr7(v: number): number {
        let a = v | 0;
        if (a < 1) {
            a = 1;
        }
        if (a > 127) {
            a = 127;
        }
        return a;
    }

    function normalizeChunk(v: number): number {
        let n = v | 0;
        if (n < 1) {
            n = 1;
        }
        if (n > 32) {
            n = 32;
        }
        return n;
    }

    function utf8Encode(text: string): Buffer {
        return control.createBufferFromUTF8(text);
    }

    function utf8DecodePart(buf: Buffer, offset: number, len: number): string {
        if (!buf || len <= 0 || offset < 0 || offset + len > buf.length) {
            return "";
        }
        const out = pins.createBuffer(len);
        for (let i = 0; i < len; i++) {
            out[i] = buf[offset + i];
        }
        return out.toString();
    }

    function crc8(data: Buffer, length: number): number {
        let crc = 0;
        const n = minNumber(length, data.length);
        for (let i = 0; i < n; i++) {
            crc = (crc ^ (data[i] & 0xFF)) & 0xFF;
            for (let b = 0; b < 8; b++) {
                if ((crc & 0x80) != 0) {
                    crc = (((crc << 1) & 0xFF) ^ 0x07) & 0xFF;
                } else {
                    crc = (crc << 1) & 0xFF;
                }
            }
        }
        return crc & 0xFF;
    }

    function buildUDevicePacket(command: number, params: Buffer): Buffer {
        const pLen = params ? params.length : 0;
        const packet = pins.createBuffer(pLen + 4);
        packet[0] = UDEV_FRAME_HEAD;
        packet[1] = clampByte(command);
        packet[2] = clampByte(pLen);
        for (let i = 0; i < pLen; i++) {
            packet[3 + i] = params[i];
        }
        packet[3 + pLen] = crc8(packet, pLen + 3);
        return packet;
    }

    function deviceWrite(command: number, params: Buffer, retryCount: number = 1): boolean {
        const packet = buildUDevicePacket(command, params);
        const retry = maxNumber(1, retryCount | 0);
        for (let i = 0; i < retry; i++) {
            pins.i2cWriteBuffer(deviceAddr, packet, false);
            return true;
        }
        return false;
    }

    function deviceRead(command: number, params: Buffer, readLen: number): Buffer {
        if (readLen <= 0) {
            return pins.createBuffer(0);
        }

        const packet = buildUDevicePacket(command, params);
        pins.i2cWriteBuffer(deviceAddr, packet, false);

        if (ioGapMs > 0) {
            basic.pause(ioGapMs);
        }

        const raw = pins.i2cReadBuffer(deviceAddr, (readLen | 0) + 1, false);
        if (!raw || raw.length < readLen + 1) {
            return pins.createBuffer(0);
        }

        const calc = crc8(raw, readLen);
        const recv = raw[readLen] & 0xFF;
        if (calc != recv) {
            return pins.createBuffer(0);
        }

        const out = pins.createBuffer(readLen);
        for (let i = 0; i < readLen; i++) {
            out[i] = raw[i];
        }
        return out;
    }

    function buildUartFrame(command: number, payload: Buffer): Buffer {
        const bodyLen = payload ? payload.length : 0;
        const frame = pins.createBuffer(4 + bodyLen);
        frame[0] = UART_FRAME_HEAD_0;
        frame[1] = UART_FRAME_HEAD_1;
        frame[2] = clampByte(command);
        frame[3] = clampByte(bodyLen);
        for (let i = 0; i < bodyLen; i++) {
            frame[4 + i] = payload[i];
        }
        return frame;
    }

    function writeUartFrame(frame: Buffer): boolean {
        if (!frame || frame.length <= 0) {
            return false;
        }

        // u_device param_len 为 1 字节，0x30 透传参数格式 [0, frame_len, frame...]
        // 所以要求 2 + frame_len <= 255，即 frame_len <= 253
        if (frame.length > 253) {
            return false;
        }

        const params = pins.createBuffer(2 + frame.length);
        params[0] = 0;
        params[1] = frame.length & 0xFF;
        for (let i = 0; i < frame.length; i++) {
            params[2 + i] = frame[i];
        }

        return deviceWrite(UDEV_CMD_UART_TUNNEL, params, 3);
    }

    function sendUartCommandArray(command: number, params: number[]): boolean {
        const payload = pins.createBuffer(params.length);
        for (let i = 0; i < params.length; i++) {
            payload[i] = clampByte(params[i]);
        }
        const frame = buildUartFrame(command, payload);
        return writeUartFrame(frame);
    }

    function regReadOnce(addr: number, length: number): Buffer {
        const req = pins.createBuffer(4);
        req[0] = (addr >> 8) & 0xFF;
        req[1] = addr & 0xFF;
        req[2] = 0;
        req[3] = length & 0xFF;
        return deviceRead(UDEV_CMD_READ_REG, req, length);
    }

    function regReadRetry(addr: number, length: number, retry: number = 3): Buffer {
        let last = pins.createBuffer(0);
        const times = maxNumber(1, retry | 0);
        for (let i = 0; i < times; i++) {
            const ret = regReadOnce(addr, length);
            last = ret;
            if (ret && ret.length >= length) {
                return ret;
            }
            basic.pause(2);
        }
        return last;
    }

    function regReadBytes(addr: number, totalLen: number, chunkSize: number = 10, retry: number = 3): Buffer {
        if (totalLen <= 0) {
            return pins.createBuffer(0);
        }

        const normalizedChunk = normalizeChunk(chunkSize);
        const out = pins.createBuffer(totalLen);
        let offset = 0;

        while (offset < totalLen) {
            const n = minNumber(normalizedChunk, totalLen - offset);
            const part = regReadRetry(addr + offset, n, retry);
            if (!part || part.length < n) {
                break;
            }

            for (let i = 0; i < n; i++) {
                out[offset + i] = part[i];
            }

            offset += n;
            if (offset < totalLen && ioGapMs > 0) {
                basic.pause(ioGapMs);
            }
        }

        if (offset >= totalLen) {
            return out;
        }

        const partial = pins.createBuffer(offset);
        for (let i = 0; i < offset; i++) {
            partial[i] = out[i];
        }
        return partial;
    }

    function regWriteBytes(addr: number, data: Buffer, chunkSize: number = 10, gapMs: number = 10): boolean {
        if (!data || data.length <= 0) {
            return false;
        }

        const normalizedChunk = normalizeChunk(chunkSize);
        const normalizedGap = maxNumber(0, gapMs | 0);

        let offset = 0;
        const total = data.length;

        while (offset < total) {
            const n = minNumber(normalizedChunk, total - offset);
            const payload = pins.createBuffer(4 + n);
            payload[0] = ((addr + offset) >> 8) & 0xFF;
            payload[1] = (addr + offset) & 0xFF;
            payload[2] = 0;
            payload[3] = n & 0xFF;
            for (let i = 0; i < n; i++) {
                payload[4 + i] = data[offset + i];
            }

            if (!deviceWrite(UDEV_CMD_WRITE_REG, payload, 1)) {
                return false;
            }

            offset += n;
            if (offset < total && normalizedGap > 0) {
                basic.pause(normalizedGap);
            }
        }

        return true;
    }

    function modeName(mode: AppMode): string {
        if (mode == AppMode.Launcher) {
            return "launcher";
        }
        if (mode == AppMode.FaceRecognize) {
            return "face";
        }
        if (mode == AppMode.SelfLearn) {
            return "self";
        }
        if (mode == AppMode.HandRecognize) {
            return "hand";
        }
        if (mode == AppMode.RemoteFileManager) {
            return "file";
        }
        if (mode == AppMode.Photos) {
            return "photos";
        }
        if (mode == AppMode.Camera) {
            return "camera";
        }
        if (mode == AppMode.Settings) {
            return "settings";
        }
        if (mode == AppMode.SoundTouch) {
            return "sound touch";
        }
        return "unknown";
    }

    function switchModeInternal(mode: AppMode, retryAfterFirst: number = 3, timeoutMs: number = 6000): boolean {
        const target = mode as number;
        const totalAttempts = 1 + maxNumber(0, retryAfterFirst | 0);

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            sendUartCommandArray(target, [0]);
            const deadline = input.runningTime() + timeoutMs;

            while (input.runningTime() < deadline) {
                basic.pause(20);
                const cur = regReadRetry(REG_APP_ID, 1, 2);
                if (cur && cur.length >= 1 && (cur[0] & 0xFF) == (target & 0xFF)) {
                    currentMode = mode;
                    return true;
                }
            }

            if (attempt + 1 < totalAttempts) {
                basic.pause(120);
            }
        }

        return false;
    }

    function parseFacePacket(raw: Buffer): boolean {
        if (!raw || raw.length < 6) {
            return false;
        }

        faceStatusCache = raw[0] & 0xFF;
        faceIdCache = raw[1] & 0xFF;
        faceSimilarityCache = minNumber((raw[2] & 0xFF) / 100.0, 1.0);
        faceBlinkCache = raw[3] & 0xFF;
        faceMouthOpenCache = raw[4] & 0xFF;

        const labelLen = raw[5] & 0xFF;
        if (labelLen > 0 && raw.length >= 6 + labelLen) {
            faceLabelCache = utf8DecodePart(raw, 6, labelLen);
        } else {
            faceLabelCache = "";
        }
        return true;
    }

    function parseSelfLearnPacket(raw: Buffer): boolean {
        if (!raw || raw.length < 4) {
            return false;
        }

        selfLearnStatusCache = raw[0] & 0xFF;
        selfLearnIdCache = raw[1] & 0xFF;
        selfLearnSimilarityCache = minNumber((raw[2] & 0xFF) / 100.0, 1.0);

        const labelLen = raw[3] & 0xFF;
        if (labelLen > 0 && raw.length >= 4 + labelLen) {
            selfLearnLabelCache = utf8DecodePart(raw, 4, labelLen);
        } else {
            selfLearnLabelCache = "";
        }
        return true;
    }

    function parseHandPacket(raw: Buffer): boolean {
        if (!raw || raw.length < 5) {
            return false;
        }

        handStatusCache = raw[0] & 0xFF;
        handIdCache = raw[1] & 0xFF;
        handSimilarityCache = minNumber((raw[2] & 0xFF) / 100.0, 1.0);
        handPoseSimilarityCache = minNumber((raw[3] & 0xFF) / 100.0, 1.0);

        const labelLen = raw[4] & 0xFF;
        if (labelLen > 0 && raw.length >= 5 + labelLen) {
            handLabelCache = utf8DecodePart(raw, 5, labelLen);
        } else {
            handLabelCache = "";
        }
        return true;
    }

    function parseSoundTouchPacket(raw: Buffer): boolean {
        if (!raw || raw.length < 7) {
            return false;
        }

        soundTouchStatusCache = raw[0] & 0xFF;
        soundTouchBpmCache = ((raw[2] & 0xFF) << 8) | (raw[1] & 0xFF);
        soundTouchBeatCountCache = ((raw[4] & 0xFF) << 8) | (raw[3] & 0xFF);
        const durationDs = ((raw[6] & 0xFF) << 8) | (raw[5] & 0xFF);
        soundTouchDurationSecCache = durationDs / 10.0;

        if (soundTouchStatusCache == SoundState.ResultReady) {
            soundTouchMessageCache = "done";
        } else if (soundTouchStatusCache == SoundState.Recording) {
            soundTouchMessageCache = "recording";
        } else if (soundTouchStatusCache == SoundState.Processing) {
            soundTouchMessageCache = "processing";
        } else if (soundTouchStatusCache == SoundState.State4) {
            soundTouchMessageCache = "state4";
        } else {
            soundTouchMessageCache = "idle";
        }

        return true;
    }

    function refreshFaceResultInternal(): boolean {
        const head = regReadRetry(REG_RESULT_BASE, 6, 2);
        if (!head || head.length < 6) {
            return false;
        }

        const labelLen = head[5] & 0xFF;
        const totalLen = 6 + labelLen;
        const raw = regReadBytes(REG_RESULT_BASE, totalLen, ioChunk, 3);
        return parseFacePacket(raw);
    }

    function refreshSelfLearnResultInternal(): boolean {
        const head = regReadRetry(REG_RESULT_BASE, 4, 2);
        if (!head || head.length < 4) {
            return false;
        }

        const labelLen = head[3] & 0xFF;
        const totalLen = 4 + labelLen;
        const raw = regReadBytes(REG_RESULT_BASE, totalLen, ioChunk, 3);
        return parseSelfLearnPacket(raw);
    }

    function refreshHandResultInternal(): boolean {
        const head = regReadRetry(REG_RESULT_BASE, 5, 2);
        if (!head || head.length < 5) {
            return false;
        }

        const labelLen = head[4] & 0xFF;
        const totalLen = 5 + labelLen;
        const raw = regReadBytes(REG_RESULT_BASE, totalLen, ioChunk, 3);
        return parseHandPacket(raw);
    }

    function refreshSoundTouchResultInternal(): boolean {
        const raw = regReadRetry(REG_RESULT_BASE, 7, 2);
        return parseSoundTouchPacket(raw);
    }

    //% block="set device i2c address %addr"
    //% addr.min=1 addr.max=127 addr.defl=96
    //% blockHidden=1
    //% weight=110
    //% group="Config"
    export function setDeviceI2CAddress(addr: number): void {
        deviceAddr = normalizeAddr7(addr);
    }

    //% block="set i2c address %addr"
    //% addr.min=1 addr.max=127 addr.defl=96
    //% blockHidden=1
    //% weight=108
    //% group="Config"
    export function setI2CAddress(addr: number): void {
        setDeviceI2CAddress(addr);
    }

    //% block="set io chunk %chunk gap %gap ms"
    //% chunk.min=1 chunk.max=32 chunk.defl=10
    //% gap.min=0 gap.max=100 gap.defl=10
    //% blockHidden=1
    //% weight=109
    //% group="Config"
    export function setIOTuning(chunk: number, gap: number): void {
        ioChunk = normalizeChunk(chunk);
        ioGapMs = maxNumber(0, gap | 0);
    }

    //% block="current app mode"
    //% blockHidden=1
    //% weight=100
    //% group="Config"
    export function getCurrentMode(): AppMode {
        return currentMode;
    }

    //% block="switch to %mode"
    //% weight=90
    //% group="App"
    export function switchTo(mode: AppMode): void {
        switchModeInternal(mode, 3, 6000);
    }

    //% block="switch to launcher"
    //% weight=89
    //% group="App"
    export function backToLauncher(): void {
        switchModeInternal(AppMode.Launcher, 2, 5000);
    }

    //% block="set rgb %color"
    //% weight=88
    //% group="App"
    export function setRgb(color: RgbColor): void {
        sendUartCommandArray(UART_CMD_RGB_CONTROL, [color as number]);
    }

    //% block="refresh result"
    //% weight=80
    //% group="Result"
    export function refreshResult(): void {
        if (currentMode == AppMode.FaceRecognize) {
            refreshFaceResultInternal();
            return;
        }
        if (currentMode == AppMode.SelfLearn) {
            refreshSelfLearnResultInternal();
            return;
        }
        if (currentMode == AppMode.HandRecognize) {
            refreshHandResultInternal();
            return;
        }
        if (currentMode == AppMode.SoundTouch) {
            refreshSoundTouchResultInternal();
            return;
        }
    }

    //% block="refresh face result"
    //% weight=79
    //% group="Face"
    export function refreshFaceResult(): void {
        refreshFaceResultInternal();
    }

    //% block="face status"
    //% weight=78
    //% group="Face"
    export function faceStatus(): number {
        return faceStatusCache;
    }

    //% block="face id"
    //% weight=77
    //% group="Face"
    export function faceId(): number {
        return faceIdCache;
    }

    //% block="face label"
    //% weight=76
    //% group="Face"
    export function faceLabel(): string {
        return faceLabelCache;
    }

    //% block="face similarity"
    //% weight=75
    //% group="Face"
    export function faceSimilarity(): number {
        return faceSimilarityCache;
    }

    //% block="face blink"
    //% weight=74
    //% group="Face"
    export function faceBlink(): number {
        return faceBlinkCache;
    }

    //% block="face mouth open"
    //% weight=73
    //% group="Face"
    export function faceMouthOpen(): number {
        return faceMouthOpenCache;
    }

    //% block="refresh self learn result"
    //% weight=70
    //% group="Self Learn"
    export function refreshSelfLearnResult(): void {
        refreshSelfLearnResultInternal();
    }

    //% block="self learn status"
    //% weight=69
    //% group="Self Learn"
    export function selfLearnStatus(): number {
        return selfLearnStatusCache;
    }

    //% block="self learn id"
    //% weight=68
    //% group="Self Learn"
    export function selfLearnId(): number {
        return selfLearnIdCache;
    }

    //% block="self learn label"
    //% weight=67
    //% group="Self Learn"
    export function selfLearnLabel(): string {
        return selfLearnLabelCache;
    }

    //% block="self learn similarity"
    //% weight=66
    //% group="Self Learn"
    export function selfLearnSimilarity(): number {
        return selfLearnSimilarityCache;
    }

    //% block="refresh hand result"
    //% weight=60
    //% group="Hand"
    export function refreshHandResult(): void {
        refreshHandResultInternal();
    }

    //% block="hand status"
    //% weight=59
    //% group="Hand"
    export function handStatus(): number {
        return handStatusCache;
    }

    //% block="hand id"
    //% weight=58
    //% group="Hand"
    export function handId(): number {
        return handIdCache;
    }

    //% block="hand label"
    //% weight=57
    //% group="Hand"
    export function handLabel(): string {
        return handLabelCache;
    }

    //% block="hand similarity"
    //% weight=56
    //% group="Hand"
    export function handSimilarity(): number {
        return handSimilarityCache;
    }

    //% block="hand pose similarity"
    //% weight=55
    //% group="Hand"
    export function handPoseSimilarity(): number {
        return handPoseSimilarityCache;
    }

    //% block="send sound touch path %path auto upload %upload"
    //% upload.defl=true
    //% weight=50
    //% group="Sound Touch"
    export function sendSoundTouchPath(path: string, upload: boolean): void {
        const text = ("" + path).trim();
        if (!text) {
            return;
        }

        const body = utf8Encode(text);
        // u_device 0x30 透传最大限制下，path 最大 248 字节
        let bodyLen = body.length;
        if (bodyLen > 248) {
            bodyLen = 248;
        }

        const payload = pins.createBuffer(1 + bodyLen);
        payload[0] = bodyLen & 0xFF;
        for (let i = 0; i < bodyLen; i++) {
            payload[1 + i] = body[i];
        }

        const frame = buildUartFrame(UART_CMD_SOUND_TOUCH_PATH, payload);
        const ok = writeUartFrame(frame);
        if (ok && upload) {
            basic.pause(30);
            sendUartCommandArray(UART_CMD_SOUND_TOUCH_UPLOAD, [0x01]);
        }
    }

    //% block="sound touch record %enable"
    //% enable.defl=true
    //% weight=49
    //% group="Sound Touch"
    export function soundTouchRecord(enable: boolean): void {
        const cmd = enable ? SOUND_CTRL_CMD_START : SOUND_CTRL_CMD_STOP;
        sendUartCommandArray(UART_CMD_SOUND_TOUCH_CTRL, [cmd]);
    }

    //% block="sound touch upload"
    //% weight=48
    //% group="Sound Touch"
    export function soundTouchUpload(): void {
        sendUartCommandArray(UART_CMD_SOUND_TOUCH_UPLOAD, [0x01]);
    }

    //% block="refresh sound touch result"
    //% weight=47
    //% group="Sound Touch"
    export function refreshSoundTouchResult(): void {
        refreshSoundTouchResultInternal();
    }

    //% block="sound touch status"
    //% weight=46
    //% group="Sound Touch"
    export function soundTouchStatus(): number {
        return soundTouchStatusCache;
    }

    //% block="sound touch bpm"
    //% weight=45
    //% group="Sound Touch"
    export function soundTouchBpm(): number {
        return soundTouchBpmCache;
    }

    //% block="sound touch beat count"
    //% weight=44
    //% group="Sound Touch"
    export function soundTouchBeatCount(): number {
        return soundTouchBeatCountCache;
    }

    //% block="sound touch duration(s)"
    //% weight=43
    //% group="Sound Touch"
    export function soundTouchDurationSec(): number {
        return soundTouchDurationSecCache;
    }

    //% block="sound touch message"
    //% weight=42
    //% group="Sound Touch"
    export function soundTouchMessage(): string {
        return soundTouchMessageCache;
    }

    //% block="mode name %mode"
    //% blockHidden=1
    //% weight=10
    //% group="Advanced"
    export function appModeName(mode: AppMode): string {
        return modeName(mode);
    }

    //% block="raw reg read addr %addr len %len"
    //% addr.min=0 addr.max=65535 addr.defl=100
    //% len.min=1 len.max=64 len.defl=8
    //% blockHidden=1
    //% weight=9
    //% group="Advanced"
    export function rawReadRegister(addr: number, len: number): Buffer {
        const n = minNumber(maxNumber(1, len | 0), 64);
        return regReadRetry(addr | 0, n, 2);
    }

    //% block="raw reg write addr %addr data %data"
    //% addr.min=0 addr.max=65535 addr.defl=100
    //% blockHidden=1
    //% weight=8
    //% group="Advanced"
    export function rawWriteRegister(addr: number, data: Buffer): boolean {
        return regWriteBytes(addr | 0, data, ioChunk, ioGapMs);
    }
}
