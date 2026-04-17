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
    const INIT_IIC_MAX_RETRY = 3;
    const INIT_IIC_ATTEMPT_TIMEOUT_MS = 300;
    const INIT_IIC_POLL_INTERVAL_MS = 20;

    let deviceAddr = UDEV_DEVICE_ADDR_DEFAULT;

    let ioChunk = 10;
    let ioGapMs = 1;
    let iicInitDone = false;
    let cameraOnline = false;

    let faceStatusCache = 0;
    let faceIdCache = 0;
    let faceSimilarityCache = 0;
    let faceBlinkCache = 0;
    let faceMouthOpenCache = 0;
    let faceCoordValidCache = 0;
    let faceLeftTopXCache = 0;
    let faceLeftTopYCache = 0;
    let faceRightBottomXCache = 0;
    let faceRightBottomYCache = 0;
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
        //% block="main menu"
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

    export enum FaceCoordinate {
        //% block="center x"
        CenterX = 0,
        //% block="center y"
        CenterY = 1,
        //% block="left top x"
        LeftTopX = 2,
        //% block="left top y"
        LeftTopY = 3,
        //% block="right bottom x"
        RightBottomX = 4,
        //% block="right bottom y"
        RightBottomY = 5,
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

    function u16le(buf: Buffer, offset: number): number {
        if (!buf || offset < 0 || offset + 1 >= buf.length) {
            return 0;
        }
        return ((buf[offset + 1] & 0xFF) << 8) | (buf[offset] & 0xFF);
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

    function regWriteBytes(addr: number, data: Buffer, chunkSize: number = 10, gapMs: number = 1): boolean {
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
            return "main menu";
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

    function updateCurrentModeById(appId: number): boolean {
        const id = appId & 0xFF;
        if (id == (AppMode.Launcher as number)) {
            currentMode = AppMode.Launcher;
            return true;
        }
        if (id == (AppMode.FaceRecognize as number)) {
            currentMode = AppMode.FaceRecognize;
            return true;
        }
        if (id == (AppMode.SelfLearn as number)) {
            currentMode = AppMode.SelfLearn;
            return true;
        }
        if (id == (AppMode.HandRecognize as number)) {
            currentMode = AppMode.HandRecognize;
            return true;
        }
        if (id == (AppMode.RemoteFileManager as number)) {
            currentMode = AppMode.RemoteFileManager;
            return true;
        }
        if (id == (AppMode.Photos as number)) {
            currentMode = AppMode.Photos;
            return true;
        }
        if (id == (AppMode.Camera as number)) {
            currentMode = AppMode.Camera;
            return true;
        }
        if (id == (AppMode.Settings as number)) {
            currentMode = AppMode.Settings;
            return true;
        }
        if (id == (AppMode.SoundTouch as number)) {
            currentMode = AppMode.SoundTouch;
            return true;
        }
        return false;
    }

    function markCameraOffline(): void {
        cameraOnline = false;
    }

    function isCameraReady(): boolean {
        return iicInitDone && cameraOnline;
    }

    function probeCamera(retry: number = 2): boolean {
        const cur = regReadRetry(REG_APP_ID, 1, retry);
        if (cur && cur.length >= 1) {
            const id = cur[0] & 0xFF;
            if (updateCurrentModeById(id)) {
                cameraOnline = true;
                return true;
            }
        }
        markCameraOffline();
        return false;
    }

    function probeCameraWithTimeout(attemptTimeoutMs: number): boolean {
        const timeout = maxNumber(1, attemptTimeoutMs | 0);
        const interval = maxNumber(1, INIT_IIC_POLL_INTERVAL_MS | 0);
        const deadline = input.runningTime() + timeout;

        while (input.runningTime() < deadline) {
            if (probeCamera(1)) {
                return true;
            }
            basic.pause(interval);
        }
        return false;
    }

    function probeCameraInit(): boolean {
        for (let i = 0; i < INIT_IIC_MAX_RETRY; i++) {
            if (probeCameraWithTimeout(INIT_IIC_ATTEMPT_TIMEOUT_MS)) {
                return true;
            }
        }
        markCameraOffline();
        return false;
    }

    function detectModeIdFromDevice(): number {
        if (!isCameraReady()) {
            return currentMode as number;
        }

        const cur = regReadRetry(REG_APP_ID, 1, 2);
        if (cur && cur.length >= 1) {
            const id = cur[0] & 0xFF;
            if (updateCurrentModeById(id)) {
                cameraOnline = true;
                return id;
            }
        }
        markCameraOffline();
        return currentMode as number;
    }

    function tryReadModeId(retry: number = 2): number {
        if (!isCameraReady()) {
            return -1;
        }

        const cur = regReadRetry(REG_APP_ID, 1, retry);
        if (cur && cur.length >= 1) {
            const id = cur[0] & 0xFF;
            if (updateCurrentModeById(id)) {
                cameraOnline = true;
                return id;
            }
        }
        markCameraOffline();
        return -1;
    }

    function switchModeInternal(mode: AppMode, retryAfterFirst: number = 3, timeoutMs: number = 6000): boolean {
        if (!isCameraReady()) {
            return false;
        }

        const target = mode as number;
        const totalAttempts = 1 + maxNumber(0, retryAfterFirst | 0);

        // 已在目标模式时直接返回，避免重复切换导致阻塞。
        const currentId = tryReadModeId(2);
        if (currentId == (target & 0xFF)) {
            currentMode = mode;
            return true;
        }

        // 读取失败时回退到缓存模式，降低"已在目标模式但卡住等待"的概率。
        if (currentId < 0 && ((currentMode as number) & 0xFF) == (target & 0xFF)) {
            return true;
        }

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            if (!sendUartCommandArray(target, [0])) {
                markCameraOffline();
                return false;
            }
            const deadline = input.runningTime() + timeoutMs;
            let missCount = 0;

            while (input.runningTime() < deadline) {
                basic.pause(20);
                const id = tryReadModeId(1);
                if (id == (target & 0xFF)) {
                    currentMode = mode;
                    return true;
                }
                if (id < 0) {
                    missCount += 1;
                    if (missCount >= 3) {
                        markCameraOffline();
                        return false;
                    }
                } else {
                    missCount = 0;
                }
            }

            if (attempt + 1 < totalAttempts) {
                basic.pause(120);
            }
        }

        return false;
    }

    function parseFacePacket(raw: Buffer): boolean {
        if (!raw || raw.length < 15) {
            return false;
        }

        faceStatusCache = raw[0] & 0xFF;
        faceIdCache = raw[1] & 0xFF;
        faceSimilarityCache = minNumber((raw[2] & 0xFF) / 100.0, 1.0);
        faceBlinkCache = raw[3] & 0xFF;
        faceMouthOpenCache = raw[4] & 0xFF;
        const coordValid = raw[5] & 0xFF;
        const nextLeftTopX = u16le(raw, 6);
        const nextLeftTopY = u16le(raw, 8);
        const nextRightBottomX = u16le(raw, 10);
        const nextRightBottomY = u16le(raw, 12);
        const isDegenerateBox = nextLeftTopX == nextRightBottomX && nextLeftTopY == nextRightBottomY;

        if (isDegenerateBox) {
            faceCoordValidCache = 0;
        } else {
            if (coordValid != 0) {
                faceLeftTopXCache = nextLeftTopX;
                faceLeftTopYCache = nextLeftTopY;
                faceRightBottomXCache = nextRightBottomX;
                faceRightBottomYCache = nextRightBottomY;
                faceCoordValidCache = 1;
            } else {
                faceCoordValidCache = 0;
            }
        }
        const labelLen = raw[14] & 0xFF;
        if (labelLen > 0 && raw.length >= 15 + labelLen) {
            faceLabelCache = utf8DecodePart(raw, 15, labelLen);
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
        const head = regReadRetry(REG_RESULT_BASE, 15, 2);
        if (!head || head.length < 15) {
            return false;
        }

        const labelLen = head[14] & 0xFF;
        const totalLen = 15 + labelLen;
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

    //% block="IIC 初始化AI摄像头"
    //% weight=111
    //% group="Config"
    export function iicInitCamera(): void {
        deviceAddr = UDEV_DEVICE_ADDR_DEFAULT;
        iicInitDone = true;
        cameraOnline = false;
        probeCameraInit();
    }

    //% block="set device i2c address %addr"
    //% addr.min=1 addr.max=127 addr.defl=96
    //% blockHidden=1
    //% weight=110
    //% group="Config"
    export function setDeviceI2CAddress(addr: number): void {
        deviceAddr = normalizeAddr7(addr);
        iicInitDone = false;
        cameraOnline = false;
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
    //% gap.min=0 gap.max=100 gap.defl=1
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

    //% block="switch function to %mode"
    //% weight=90
    //% group="App"
    export function switchTo(mode: AppMode): void {
        if (!isCameraReady()) {
            return;
        }
        switchModeInternal(mode, 3, 6000);
    }

    //% block="switch to launcher"
    //% blockHidden=1
    //% weight=89
    //% group="App"
    export function backToLauncher(): void {
        if (!isCameraReady()) {
            return;
        }
        switchModeInternal(AppMode.Launcher, 2, 5000);
    }

    //% block="set rgb %color"
    //% weight=88
    //% group="App"
    export function setRgb(color: RgbColor): void {
        if (!isCameraReady()) {
            return;
        }
        sendUartCommandArray(UART_CMD_RGB_CONTROL, [color as number]);
    }

    //% block="refresh recognize result"
    //% weight=80
    //% group="Result"
    export function refreshResult(): void {
        if (!isCameraReady()) {
            return;
        }
        const modeId = detectModeIdFromDevice();
        if (modeId == (AppMode.FaceRecognize as number)) {
            refreshFaceResultInternal();
            return;
        }
        if (modeId == (AppMode.SelfLearn as number)) {
            refreshSelfLearnResultInternal();
            return;
        }
        if (modeId == (AppMode.HandRecognize as number)) {
            refreshHandResultInternal();
            return;
        }
        if (modeId == (AppMode.SoundTouch as number)) {
            refreshSoundTouchResultInternal();
            return;
        }
    }

    //% block="refresh face result"
    //% blockHidden=1
    //% weight=79
    //% group="Face"
    export function refreshFaceResult(): void {
        if (!isCameraReady()) {
            return;
        }
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

    //% block="detected face"
    //% weight=72
    //% group="Face"
    export function detectedUnrecognizedFace(): boolean {
        return faceCoordValidCache != 0;
    }

    //% block="detected recognized face"
    //% weight=71
    //% group="Face"
    export function detectedRecognizedFace(): boolean {
        return faceStatusCache == 1;
    }

    function hasValidFaceCenterData(): boolean {
        if (faceCoordValidCache == 0) {
            return false;
        }
        return !(faceLeftTopXCache == faceRightBottomXCache && faceLeftTopYCache == faceRightBottomYCache);
    }

    //% block="face coordinate %coord"
    //% weight=70
    //% group="Face"
    export function faceCoordinate(coord: FaceCoordinate): number {
        if (coord == FaceCoordinate.CenterX) {
            if (!hasValidFaceCenterData()) {
                return 160;
            }
            let x = (faceLeftTopXCache + faceRightBottomXCache) >> 1;
            if (x < 0) {
                x = 0;
            }
            if (x > 320) {
                x = 320;
            }
            if (x == 0 || x == 320) {
                return 160;
            }
            return x;
        }
        if (coord == FaceCoordinate.CenterY) {
            if (!hasValidFaceCenterData()) {
                return 120;
            }
            let y = 240 - ((faceLeftTopYCache + faceRightBottomYCache) >> 1);
            if (y < 0) {
                y = 0;
            }
            if (y > 240) {
                y = 240;
            }
            if (y == 0 || y == 240) {
                return 120;
            }
            return y;
        }
        if (coord == FaceCoordinate.LeftTopX) {
            return faceLeftTopXCache;
        }
        if (coord == FaceCoordinate.LeftTopY) {
            return faceLeftTopYCache;
        }
        if (coord == FaceCoordinate.RightBottomX) {
            return faceRightBottomXCache;
        }
        return faceRightBottomYCache;
    }

    //% block="refresh self learn result"
    //% blockHidden=1
    //% weight=70
    //% group="Self Learn"
    export function refreshSelfLearnResult(): void {
        if (!isCameraReady()) {
            return;
        }
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

    //% block="detected learned object"
    //% weight=65
    //% group="Self Learn"
    export function detectedLearnedObject(): boolean {
        return selfLearnStatusCache == 1;
    }

    //% block="refresh hand result"
    //% blockHidden=1
    //% weight=60
    //% group="Hand"
    export function refreshHandResult(): void {
        if (!isCameraReady()) {
            return;
        }
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

    //% block="detected learned gesture"
    //% weight=54
    //% group="Hand"
    export function detectedLearnedGesture(): boolean {
        return handStatusCache == 1;
    }

    //% block="send sound touch path %path auto upload %upload"
    //% upload.defl=true
    //% weight=50
    //% group="Sound Touch"
    export function sendSoundTouchPath(path: string, upload: boolean): void {
        if (!isCameraReady()) {
            return;
        }
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
        if (!isCameraReady()) {
            return;
        }
        const cmd = enable ? SOUND_CTRL_CMD_START : SOUND_CTRL_CMD_STOP;
        sendUartCommandArray(UART_CMD_SOUND_TOUCH_CTRL, [cmd]);
    }

    //% block="sound touch upload"
    //% weight=48
    //% group="Sound Touch"
    export function soundTouchUpload(): void {
        if (!isCameraReady()) {
            return;
        }
        sendUartCommandArray(UART_CMD_SOUND_TOUCH_UPLOAD, [0x01]);
    }

    //% block="refresh sound touch result"
    //% blockHidden=1
    //% weight=47
    //% group="Sound Touch"
    export function refreshSoundTouchResult(): void {
        if (!isCameraReady()) {
            return;
        }
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
        if (!isCameraReady()) {
            return pins.createBuffer(0);
        }
        const n = minNumber(maxNumber(1, len | 0), 64);
        return regReadRetry(addr | 0, n, 2);
    }

    //% block="raw reg write addr %addr data %data"
    //% addr.min=0 addr.max=65535 addr.defl=100
    //% blockHidden=1
    //% weight=8
    //% group="Advanced"
    export function rawWriteRegister(addr: number, data: Buffer): boolean {
        if (!isCameraReady()) {
            return false;
        }
        return regWriteBytes(addr | 0, data, ioChunk, ioGapMs);
    }
}
