#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hdc_probe4.py —— 固化两条已确认修法 + 推进到「提交公钥」这一跳

已由 daemon 日志（hilog）证实的两个根因：
  R1  UB 头与帧**必须分两次 bulk 写**。合并写会被当成软复位整包丢弃：
        [SendToHdcStream:189] SendToHdcStream softreset dataSize:61 payloadSize:0
  R2  `version` 必须与 daemon **完整版本串逐字节相等**：
        [DaemonSessionHandshake:1032] failed! version not match
            [Ver: 3.2.0f] vs [Ver: 3.2.0f73c487f8b34a2ba5]

本脚本流程：
  Step 0  被动读，学设备当前 UB sid（仅作记录）
  Step 1  发送握手 authType=AUTH_NONE，sid=0，version=完整版本   → 期望 daemon 回 authType=3
  Step 2  发送握手 authType=AUTH_PUBLICKEY(3)，connectKey=公钥文本 → 期望 daemon 回 token（约 20 字节）
  Step 3  若有 token 且本机有私钥 + openssl：尝试签名（PKCS#1 v1.5 / SHA-512，384 字节）并记录

公钥来源（按顺序尝试）：
  %USERPROFILE%\\.harmony\\hdc_rsa.pub
  %USERPROFILE%\\.harmony\\hdc_rsa
  ~/.harmony/hdc_rsa.pub
  也可用 --pubkey 显式指定。

用法：
  hdc kill
  python hdc_probe4.py
  python hdc_probe4.py --version "Ver: 3.2.0f73c487f8b34a2ba5"
  python hdc_probe4.py --pubkey "C:\\Users\\me\\.harmony\\hdc_rsa.pub"

安全：只 claim / bulk 读写 / clear_halt / release。不写设备文件。
     若 IN 端点 STALL，脚本会 clear_halt 后重试。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
from ctypes import POINTER, byref, c_int, c_uint, c_uint8, c_uint16, c_void_p

# ---- 协议常量（源码 define_enum.h / session.h）----
USB_HEAD = 11
OPT_HEADER, OPT_RESET = 1, 2
EP_IN, EP_OUT, IFACE = 0x81, 0x01, 0
VCODE = 0x09
BANNER = b"OHOS HDC"
CMD_HANDSHAKE = 1
AUTH_NONE, AUTH_TOKEN, AUTH_SIGNATURE, AUTH_PUBLICKEY, AUTH_OK = 0, 1, 2, 3, 4
AUTH_NAMES = {0: "NONE", 1: "TOKEN", 2: "SIGNATURE", 3: "PUBLICKEY", 4: "OK", 5: "FAIL"}
TIMEOUT, PIPE = -7, -9
ERR = {0: "OK", -1: "IO", -3: "ACCESS", -4: "NO_DEVICE", -6: "BUSY",
       -7: "TIMEOUT", -9: "PIPE"}

# daemon 实测完整版本串（日志原文）
DAEMON_VERSION = b"Ver: 3.2.0f73c487f8b34a2ba5"


def log(m):
    print(m, flush=True)


def hexdump(d):
    return "\n".join(
        f"  {i:04X}  {' '.join(f'{b:02X}' for b in d[i:i+16]):<48}  "
        f"{''.join(chr(c) if 32 <= c < 127 else '.' for c in d[i:i+16])}"
        for i in range(0, len(d), 16))


def varint(n):
    o = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            o.append(b | 0x80)
        else:
            o.append(b)
            return bytes(o)


def fv(num, v):
    return varint(num * 8) + varint(v)


def fb(num, v):
    return varint(num * 8 + 2) + varint(len(v)) + v


def build_frame(flag, payload, channel_id=0):
    head = fv(1, channel_id) + fv(2, flag) + fv(3, 0) + fv(4, VCODE)
    return (b"HW" + b"\x00\x00" + b"\x01" + len(head).to_bytes(2, "big")
            + len(payload).to_bytes(4, "big") + head + payload)


def build_handshake(auth_type, session_id=0, connect_key=b"", buf=b"", version=DAEMON_VERSION):
    return (fb(1, BANNER) + fv(2, auth_type) + fv(3, session_id)
            + fb(4, connect_key) + fb(5, buf) + fb(6, version))


def usb_head(sid, size, option=OPT_HEADER):
    return (b"UB" + bytes([option]) + (sid & 0xFFFFFFFF).to_bytes(4, "big")
            + (size & 0xFFFFFFFF).to_bytes(4, "big"))


def parse_frame(buf):
    """尽量把一帧解析成人可读结构；解析失败返回 None（不影响日志）。"""
    if len(buf) < USB_HEAD:
        return None
    try:
        if buf[:2] == b"UB":
            sid = int.from_bytes(buf[3:7], "big")
            size = int.from_bytes(buf[7:11], "big")
            body = buf[USB_HEAD:USB_HEAD + size]
        else:
            sid, body = None, buf
        if body[:2] != b"HW":
            return None
        hs = int.from_bytes(body[5:7], "big")
        ds = int.from_bytes(body[7:11], "big")
        head, payload = body[11:11 + hs], body[11 + hs:11 + hs + ds]
        return {"ub_sid": sid, "headSize": hs, "dataSize": ds,
                "head_hex": head.hex(), "payload_hex": payload.hex(),
                "payload_ascii": ''.join(chr(c) if 32 <= c < 127 else '.' for c in payload)}
    except Exception:
        return None


def find_pubkey(explicit):
    if explicit:
        return explicit if os.path.exists(explicit) else None
    home = os.path.expanduser("~")
    for c in [os.path.join(home, ".harmony", "hdc_rsa.pub"),
              os.path.join(home, ".harmony", "hdc_rsa"),
              os.path.join(os.environ.get("USERPROFILE", home), ".harmony", "hdc_rsa.pub"),
              os.path.join(home, ".hdc", "hdc_rsa.pub")]:
        if os.path.exists(c):
            return c
    return None


class Usb:
    def __init__(self, dll):
        self.dll = d = ctypes.CDLL(dll)
        d.libusb_init.argtypes = [POINTER(c_void_p)]
        d.libusb_init.restype = c_int
        d.libusb_exit.argtypes = [c_void_p]
        d.libusb_open_device_with_vid_pid.argtypes = [c_void_p, c_uint16, c_uint16]
        d.libusb_open_device_with_vid_pid.restype = c_void_p
        d.libusb_claim_interface.argtypes = [c_void_p, c_int]
        d.libusb_release_interface.argtypes = [c_void_p, c_int]
        d.libusb_bulk_transfer.argtypes = [c_void_p, c_uint8, POINTER(c_uint8), c_int,
                                           POINTER(c_int), c_uint]
        d.libusb_clear_halt.argtypes = [c_void_p, c_uint8]
        d.libusb_close.argtypes = [c_void_p]
        self.ctx = c_void_p()
        if d.libusb_init(byref(self.ctx)) != 0:
            raise RuntimeError("libusb_init failed")

    def open(self, vid, pid):
        h = self.dll.libusb_open_device_with_vid_pid(self.ctx, vid, pid)
        if not h:
            raise RuntimeError("打不开设备：先 `hdc kill` 等 1 秒")
        return h

    def claim(self, h, n):
        return self.dll.libusb_claim_interface(h, n)

    def release(self, h, n):
        self.dll.libusb_release_interface(h, n)

    def clear_halt(self, h, ep):
        try:
            return self.dll.libusb_clear_halt(h, ep)
        except Exception:
            return None

    def read(self, h, ms=1500):
        buf = (c_uint8 * 4096)()
        got = c_int(0)
        rc = self.dll.libusb_bulk_transfer(h, EP_IN, buf, 4096, byref(got), ms)
        if rc == 0 and got.value:
            return bytes(buf[:got.value])
        return None if rc == TIMEOUT else rc

    def write(self, h, d, ms=2000):
        arr = (c_uint8 * len(d)).from_buffer_copy(d)
        got = c_int(0)
        return self.dll.libusb_bulk_transfer(h, EP_OUT, arr, len(d), byref(got), ms)

    def close(self, h):
        self.dll.libusb_close(h)


def find_libusb(p):
    if p:
        return p
    for c in [r"C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\libusb_shared.dll",
              "libusb_shared.dll", "libusb-1.0.dll"]:
        if os.path.exists(c):
            return c
    raise SystemExit("找不到 libusb，用 --libusb 指定")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vid", default="12D1")
    ap.add_argument("--pid", default="1101")
    ap.add_argument("--libusb", default=None)
    ap.add_argument("--version", default=None, help="声称的客户端版本，默认用 daemon 完整版本")
    ap.add_argument("--pubkey", default=None, help="公钥文件路径")
    ap.add_argument("--skip-pubkey-step", action="store_true")
    ap.add_argument("--out", default="hdc_probe4_log.jsonl")
    args = ap.parse_args()

    version = (args.version.encode() if args.version else DAEMON_VERSION)
    usb = Usb(find_libusb(args.libusb))
    recs = []
    h = None
    claimed = False
    try:
        h = usb.open(int(args.vid, 16), int(args.pid, 16))
        if usb.claim(h, IFACE) != 0:
            log("claim 失败；先 hdc kill")
            return 2
        claimed = True
        log(f"已 claim interface {IFACE}")
        log(f"将声称 version = {version.decode(errors='replace')!r}\n")

        # 公钥
        pk_path = find_pubkey(args.pubkey)
        pk = b""
        if pk_path:
            raw = open(pk_path, "rb").read().strip()
            log(f"找到公钥文件: {pk_path}  ({len(raw)} 字节)")
            log(f"  开头: {raw[:48].decode(errors='replace')}")
            log(f"  结尾: {raw[-32:].decode(errors='replace')}")
            # 只取 "ssh-rsa AAAA..." 那一段
            for line in raw.split(b"\n"):
                s = line.strip()
                if s.startswith(b"ssh-rsa") or s.startswith(b"AAAA"):
                    pk = s
                    break
            if not pk:
                pk = raw
            log(f"  将作为 connectKey 发送：{len(pk)} 字节")
        else:
            log("未找到 hdc 公钥文件（可稍后用 --pubkey 指定）")

        def drain(secs, tag):
            out = []
            end = time.time() + secs
            while time.time() < end:
                p = usb.read(h)
                if p is None:
                    continue
                if isinstance(p, int):
                    log(f"  [{tag}] read rc={p} {ERR.get(p,'')}")
                    if p == PIPE:
                        usb.clear_halt(h, EP_IN)
                        log("  [clear_halt] EP_IN 已复位，继续读")
                        continue
                    break
                recs.append({"phase": tag, "dir": "IN", "len": len(p), "hex": p.hex()})
                out.append(p)
                log(f"  [{tag}] IN {len(p)}B")
                log(hexdump(p))
                parsed = parse_frame(p)
                if parsed:
                    log(f"  解析: {json.dumps(parsed, ensure_ascii=False)}")
                if p[:2] == b"UB" and len(p) >= USB_HEAD:
                    hl = int.from_bytes(p[7:11], "big")
                    need = USB_HEAD + hl
                    if len(p) < need:
                        log(f"  注意：UB 宣告 {hl}B，只收到 {len(p)-USB_HEAD}B，继续读剩余")
            return out

        def send_handshake(tag, auth_type, connect_key=b"", buf=b"", sid=0):
            frame = build_frame(CMD_HANDSHAKE,
                                build_handshake(auth_type, 0, connect_key, buf, version))
            head = usb_head(sid, len(frame))
            log(f"\n--- {tag} authType={AUTH_NAMES.get(auth_type, auth_type)} "
                f"connectKey={len(connect_key)}B version={version.decode(errors='replace')!r} ---")
            log("  [1/2] 先写 UB 头（必须单独一次传输）")
            log(hexdump(head))
            rc1 = usb.write(h, head)
            log(f"        rc={rc1} {ERR.get(rc1,'')}")
            time.sleep(0.08)          # 两次 bulk 写之间给设备一点间隔
            log(f"  [2/2] 再写帧 {len(frame)}B")
            log(hexdump(frame))
            rc2 = usb.write(h, frame)
            log(f"        rc={rc2} {ERR.get(rc2,'')}")
            recs.append({"phase": tag, "dir": "OUT", "split": True,
                         "head_hex": head.hex(), "frame_hex": frame.hex(),
                         "rc_head": rc1, "rc_frame": rc2})
            time.sleep(1.2)            # 越过 NEW_SESSION_DROP_USB_DATA_TIME_MAX_MS=1000
            return drain(4.0, tag + "-reply")

        log("\n=== Step 0 被动读 3 秒（记录设备当前 sid，不做 RESET）===")
        pre = drain(3.0, "passive")
        dev_sid = 0
        for p in pre:
            if p[:2] == b"UB" and len(p) >= USB_HEAD:
                dev_sid = int.from_bytes(p[3:7], "big")
                break
        log(f"  设备 sid = 0x{dev_sid:08X}")

        log("\n=== Step 1 握手 AUTH_NONE（触发 daemon 的握手应答）===")
        r1 = send_handshake("S1", AUTH_NONE)

        if not args.skip_pubkey_step and pk:
            log("\n=== Step 2 握手 AUTH_PUBLICKEY（提交公钥，期望拿到 token）===")
            r2 = send_handshake("S2", AUTH_PUBLICKEY, connect_key=pk)
            for p in r2:
                parsed = parse_frame(p)
                if parsed and parsed.get("payload_hex"):
                    log(f"  ★ 可能的 token/应答 payload: {parsed['payload_hex']}")

        log("\n=== 汇总 ===")
        log(f"记录 {len(recs)} 条（含 {sum(1 for r in recs if r['dir']=='IN')} 个入站包）")
    finally:
        if h is not None:
            if claimed:
                usb.release(h, IFACE)
            usb.close(h)
        usb.dll.libusb_exit(usb.ctx)

    with open(args.out, "w", encoding="utf-8") as fh:
        for r in recs:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    log(f"日志：{os.path.abspath(args.out)}")
    log("收尾：`hdc list targets` 应能恢复。")
    return 0


if __name__ == "__main__":
    sys.exit(main())