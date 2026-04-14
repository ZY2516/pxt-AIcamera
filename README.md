# AIcamera (MakeCode Extension)

AIcamera is an I2C extension for LingLong AI camera control in MakeCode.

## Scope (no-auth app set only)

Implemented app modes:

- `launcher (0x01)`
- `face recognize (0x10)`
- `self learn (0x11)`
- `hand recognize (0x12)`
- `remote file manager (0x13)`
- `photos (0x14)`
- `camera (0x15)`
- `settings (0x16)`
- `sound touch (0x1B)`

Not included by design (auth/SN-key related set):

- picture recognition
- realtime model chat
- realtime voice dialog
- sound recognize
- voice to text
- text to voice

## Protocol baseline

This extension follows the `u_device` packet style on I2C device address `0x60`:

- outer packet: `[0xAA, cmd, param_len, params..., crc8]`
- register write cmd: `0x20`
- register read cmd: `0x21`
- UART tunnel cmd: `0x30`

UART tunnel payload uses reference `FF F9` frames internally.

## Use in MakeCode

1. Open https://makecode.microbit.org/
2. New project -> Extensions
3. Import this repository URL

## Basic usage idea

1. Set camera device I2C address (`set device i2c address`), default `0x60`
2. Switch app (`switch to ...`)
3. Call `refresh result` (or mode-specific refresh)
4. Read fields from corresponding getter blocks

## Metadata

for PXT/microbit
