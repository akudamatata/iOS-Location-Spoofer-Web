/**
 * iOS Location Spoofer Web
 * 
 * Copyright (c) 2026 akudamatata (https://github.com/akudamatata/iOS-Location-Spoofer-Web)
 * Licensed under CC BY-NC-SA 4.0
 * 
 * ⚠️【特别声明】：本项目完全免费开源，严禁以任何形式进行二次售卖、转售、商业收费代搭建、打包牟利等行为！
 * 若您是通过付费渠道获取本项目的，请立即申请退款并举报不良商家！
 * 
 * 【架构说明】：
 * 本脚本为 iOS-Location-Spoofer-Web 项目的核心客户端代理改写模块，专为 Shadowrocket（小火箭）环境设计。
 * 本实现采用自主重构的流式 Protobuf 编解码引擎与纯 JS 64 位整数运算（零 BigInt 依赖），
 * 原生兼容 iOS 12+ 至 iOS 27+ 各版本系统。
 *
 * 核心流程：
 * 1. 拦截 Apple /clls/wloc 定位服务响应；
 * 2. 识别封包容器（ARPC 封包 / Marker 封包 / Synthetic 封包 / Bare Protobuf / 滑窗扫描兜底）；
 * 3. 采用「WLOC 最小改写（Minimal Rewrite）」策略，仅修改经纬度与水平精度，其余字段原值透传；
 * 4. 重新组装并以原始或标准容器格式回包给系统。
 */
(function () {
  "use strict";

  /* ─────────────────────────────────────────────────────────────
     1. 配置与默认参数 (Configuration & Constants)
  ───────────────────────────────────────────────────────────── */
  var CONFIG_DEFAULTS = {
    enabled: true,
    mode: "response",
    latitude: 39.90872,
    longitude: 116.39748,
    horizontalAccuracy: 39,
    verticalAccuracy: 1000,
    altitude: 44,
    failOpen: true,
    debug: false,
    rawLimit: 0
  };

  // Apple 定位私有协议特征常数
  var APPLE_SYNTHETIC_PREFIX = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
  var APPLE_MARKER_SIGNATURE = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
  var CELL_RESPONSE_TAGS = { 22: true, 24: true };

  /* ─────────────────────────────────────────────────────────────
     2. 基础字节流与诊断工具 (Byte Stream & Diagnostic Utilities)
  ───────────────────────────────────────────────────────────── */
  var ByteUtils = {
    fromArray: function (arr) {
      return new Uint8Array(arr);
    },

    concat: function (chunks) {
      var total = 0;
      var i;
      for (i = 0; i < chunks.length; i += 1) {
        total += chunks[i].length;
      }
      var out = new Uint8Array(total);
      var offset = 0;
      for (i = 0; i < chunks.length; i += 1) {
        out.set(chunks[i], offset);
        offset += chunks[i].length;
      }
      return out;
    },

    hasPrefix: function (source, prefix) {
      if (!source || !prefix || source.length < prefix.length) {
        return false;
      }
      for (var i = 0; i < prefix.length; i += 1) {
        if (source[i] !== prefix[i]) {
          return false;
        }
      }
      return true;
    },

    findSequence: function (source, sequence) {
      if (!source || !sequence || sequence.length === 0 || source.length < sequence.length) {
        return -1;
      }
      var maxIdx = source.length - sequence.length;
      for (var i = 0; i <= maxIdx; i += 1) {
        var match = true;
        for (var j = 0; j < sequence.length; j += 1) {
          if (source[i + j] !== sequence[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          return i;
        }
      }
      return -1;
    },

    toHex: function (bytes, limit) {
      if (!bytes) return "<none>";
      var max = Math.min(bytes.length, limit || 16);
      var hex = [];
      for (var i = 0; i < max; i += 1) {
        hex.push(("0" + bytes[i].toString(16)).slice(-2));
      }
      return hex.join("");
    },

    toBinaryString: function (bytes) {
      if (!bytes) return "";
      var chunkSize = 0x8000;
      var parts = [];
      for (var i = 0; i < bytes.length; i += chunkSize) {
        var chunk = bytes.subarray(i, i + chunkSize);
        parts.push(String.fromCharCode.apply(null, Array.prototype.slice.call(chunk)));
      }
      return parts.join("");
    },

    fromBinaryString: function (str) {
      if (!str) return new Uint8Array(0);
      var out = new Uint8Array(str.length);
      for (var i = 0; i < str.length; i += 1) {
        out[i] = str.charCodeAt(i) & 0xff;
      }
      return out;
    },

    toBase64: function (bytes) {
      var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      var out = "";
      for (var i = 0; i < bytes.length; i += 3) {
        var b0 = bytes[i];
        var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        var triplet = (b0 << 16) | (b1 << 8) | b2;
        out += alphabet[(triplet >> 18) & 0x3f];
        out += alphabet[(triplet >> 12) & 0x3f];
        out += i + 1 < bytes.length ? alphabet[(triplet >> 6) & 0x3f] : "=";
        out += i + 2 < bytes.length ? alphabet[triplet & 0x3f] : "=";
      }
      return out;
    },

    toUint8Array: function (input) {
      if (input == null) return null;
      if (input instanceof Uint8Array) return input;
      if (typeof ArrayBuffer !== "undefined" && input instanceof ArrayBuffer) return new Uint8Array(input);
      if (typeof input === "string") return ByteUtils.fromBinaryString(input);
      if (typeof input === "object" && typeof input.length === "number") return new Uint8Array(input);
      if (typeof input === "object" && input.bytes && typeof input.bytes.length === "number") return new Uint8Array(input.bytes);
      if (typeof input === "object" && input.data && typeof input.data.length === "number") return new Uint8Array(input.data);
      return null;
    }
  };

  /* ─────────────────────────────────────────────────────────────
     3. 纯 JS 64 位 Varint 编解码器（Pure JS 64-bit Varint）
     零 BigInt 依赖，原生兼容 iOS 12+ JavaScriptCore
  ───────────────────────────────────────────────────────────── */
  var Varint64 = {
    UINT32_MOD: 4294967296,
    MAX_SAFE: 9007199254740991,

    fromUnsigned: function (val) {
      var num = Number(val);
      if (!Number.isFinite(num) || num < 0 || num > Varint64.MAX_SAFE) {
        throw new Error("Invalid unsigned int64 value: " + val);
      }
      return {
        low: num >>> 0,
        high: Math.floor(num / Varint64.UINT32_MOD) >>> 0
      };
    },

    fromSigned: function (val) {
      var num = Math.trunc(Number(val));
      if (!Number.isFinite(num) || Math.abs(num) > Varint64.MAX_SAFE) {
        throw new Error("Invalid signed int64 value: " + val);
      }
      if (num >= 0) {
        return Varint64.fromUnsigned(num);
      }
      var pos = Varint64.fromUnsigned(-num);
      var low = (~pos.low + 1) >>> 0;
      var carry = low === 0 ? 1 : 0;
      var high = (~pos.high + carry) >>> 0;
      return { low: low, high: high };
    },

    toSignedNumber: function (words) {
      var low = words.low >>> 0;
      var high = words.high >>> 0;
      if ((high & 0x80000000) === 0) {
        return (high >>> 0) * Varint64.UINT32_MOD + (low >>> 0);
      }
      var magLow = (~low + 1) >>> 0;
      var carry = magLow === 0 ? 1 : 0;
      var magHigh = (~high + carry) >>> 0;
      var mag = magHigh * Varint64.UINT32_MOD + magLow;
      return -mag;
    },

    encodeWords: function (words) {
      var low = words.low >>> 0;
      var high = words.high >>> 0;
      var out = [];
      while (high !== 0 || low >= 0x80) {
        out.push((low & 0x7f) | 0x80);
        low = ((low >>> 7) | (high << 25)) >>> 0;
        high = high >>> 7;
      }
      out.push(low & 0x7f);
      return ByteUtils.fromArray(out);
    },

    encodeUnsigned: function (val) {
      return Varint64.encodeWords(Varint64.fromUnsigned(val));
    },

    encodeSigned: function (val) {
      return Varint64.encodeWords(Varint64.fromSigned(val));
    },

    decode: function (bytes, offset) {
      var low = 0;
      var high = 0;
      var shift = 0;
      var current = offset || 0;
      var count = 0;

      while (current < bytes.length && count < 10) {
        var b = bytes[current];
        var payload = b & 0x7f;
        current += 1;
        count += 1;

        if (shift < 32) {
          low = (low | ((payload << shift) >>> 0)) >>> 0;
          if (shift > 25) {
            high = (high | (payload >>> (32 - shift))) >>> 0;
          }
        } else {
          high = (high | ((payload << (shift - 32)) >>> 0)) >>> 0;
        }

        if ((b & 0x80) === 0) {
          return { low: low, high: high, offset: current };
        }
        shift += 7;
      }
      throw new Error("Truncated or malformed varint");
    }
  };

  /* ─────────────────────────────────────────────────────────────
     4. Protobuf 协议处理引擎 (Protobuf Streaming Engine)
  ───────────────────────────────────────────────────────────── */
  var ProtobufEngine = {
    readFields: function (bytes) {
      var fields = [];
      var offset = 0;

      while (offset < bytes.length) {
        var fieldStart = offset;
        var tagVarint = Varint64.decode(bytes, offset);
        offset = tagVarint.offset;

        var tagVal = tagVarint.low;
        var fieldNumber = tagVal >>> 3;
        var wireType = tagVal & 0x07;

        if (fieldNumber <= 0) {
          throw new Error("Invalid protobuf field number: " + fieldNumber);
        }

        if (wireType === 0) {
          // Varint
          var valVarint = Varint64.decode(bytes, offset);
          var rawBytes = bytes.subarray(fieldStart, valVarint.offset);
          var valBytes = bytes.subarray(offset, valVarint.offset);
          fields.push({
            fieldNumber: fieldNumber,
            wireType: wireType,
            raw: rawBytes,
            valueBytes: valBytes,
            varint: valVarint,
            int64Value: Varint64.toSignedNumber(valVarint)
          });
          offset = valVarint.offset;
        } else if (wireType === 2) {
          // Length-delimited (submessage, bytes, string)
          var lenVarint = Varint64.decode(bytes, offset);
          offset = lenVarint.offset;
          var length = lenVarint.low;
          if (offset + length > bytes.length) {
            throw new Error("Protobuf length-delimited exceeds buffer bounds");
          }
          var valueBytes = bytes.subarray(offset, offset + length);
          offset += length;
          fields.push({
            fieldNumber: fieldNumber,
            wireType: wireType,
            raw: bytes.subarray(fieldStart, offset),
            valueBytes: valueBytes
          });
        } else if (wireType === 5) {
          // 32-bit fixed
          if (offset + 4 > bytes.length) throw new Error("Protobuf fixed32 truncated");
          offset += 4;
          fields.push({
            fieldNumber: fieldNumber,
            wireType: wireType,
            raw: bytes.subarray(fieldStart, offset)
          });
        } else if (wireType === 1) {
          // 64-bit fixed
          if (offset + 8 > bytes.length) throw new Error("Protobuf fixed64 truncated");
          offset += 8;
          fields.push({
            fieldNumber: fieldNumber,
            wireType: wireType,
            raw: bytes.subarray(fieldStart, offset)
          });
        } else {
          throw new Error("Unsupported wire type: " + wireType);
        }
      }
      return fields;
    },

    safeReadFields: function (bytes) {
      try {
        if (!bytes || bytes.length === 0) return null;
        var res = ProtobufEngine.readFields(bytes);
        return res.length > 0 ? res : null;
      } catch (err) {
        return null;
      }
    },

    makeVarintField: function (fieldNumber, signedOrUnsignedVal) {
      var tagBytes = Varint64.encodeUnsigned((fieldNumber << 3) | 0);
      var valBytes = typeof signedOrUnsignedVal === "number" && signedOrUnsignedVal < 0
        ? Varint64.encodeSigned(signedOrUnsignedVal)
        : Varint64.encodeSigned(signedOrUnsignedVal);
      return ByteUtils.concat([tagBytes, valBytes]);
    },

    makeLengthDelimitedField: function (fieldNumber, payloadBytes) {
      var tagBytes = Varint64.encodeUnsigned((fieldNumber << 3) | 2);
      var lenBytes = Varint64.encodeUnsigned(payloadBytes.length);
      return ByteUtils.concat([tagBytes, lenBytes, payloadBytes]);
    }
  };

  /* ─────────────────────────────────────────────────────────────
     5. Apple ARPC 封包处理 (Apple ARPC Framing Codec)
  ───────────────────────────────────────────────────────────── */
  var ArpcCodec = {
    readUInt16BE: function (bytes, offset) {
      if (offset + 2 > bytes.length) throw new Error("UInt16 out of bounds");
      return (bytes[offset] << 8) | bytes[offset + 1];
    },

    readUInt32BE: function (bytes, offset) {
      if (offset + 4 > bytes.length) throw new Error("UInt32 out of bounds");
      return (
        (bytes[offset] * 0x1000000) +
        ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
      ) >>> 0;
    },

    writeUInt16BE: function (val) {
      return ByteUtils.fromArray([(val >> 8) & 0xff, val & 0xff]);
    },

    writeUInt32BE: function (val) {
      return ByteUtils.fromArray([
        (val >>> 24) & 0xff,
        (val >>> 16) & 0xff,
        (val >>> 8) & 0xff,
        val & 0xff
      ]);
    },

    readPascalString: function (bytes, state) {
      var len = ArpcCodec.readUInt16BE(bytes, state.offset);
      state.offset += 2;
      if (state.offset + len > bytes.length) throw new Error("ARPC string out of bounds");
      var chars = [];
      for (var i = 0; i < len; i += 1) {
        chars.push(String.fromCharCode(bytes[state.offset + i]));
      }
      state.offset += len;
      return chars.join("");
    },

    writePascalString: function (str) {
      var bytes = new Uint8Array(str.length);
      for (var i = 0; i < str.length; i += 1) {
        bytes[i] = str.charCodeAt(i) & 0x7f;
      }
      return ByteUtils.concat([ArpcCodec.writeUInt16BE(bytes.length), bytes]);
    },

    parse: function (bytes) {
      var state = { offset: 0 };
      var version = ArpcCodec.readUInt16BE(bytes, state.offset);
      state.offset += 2;
      var locale = ArpcCodec.readPascalString(bytes, state);
      var appIdentifier = ArpcCodec.readPascalString(bytes, state);
      var osVersion = ArpcCodec.readPascalString(bytes, state);
      var functionId = ArpcCodec.readUInt32BE(bytes, state.offset);
      state.offset += 4;
      var payloadLength = ArpcCodec.readUInt32BE(bytes, state.offset);
      state.offset += 4;

      if (state.offset + payloadLength > bytes.length) {
        throw new Error("ARPC payload length out of bounds");
      }

      return {
        version: version,
        locale: locale,
        appIdentifier: appIdentifier,
        osVersion: osVersion,
        functionId: functionId,
        payload: bytes.slice(state.offset, state.offset + payloadLength)
      };
    },

    serialize: function (arpc) {
      return ByteUtils.concat([
        ArpcCodec.writeUInt16BE(arpc.version),
        ArpcCodec.writePascalString(arpc.locale),
        ArpcCodec.writePascalString(arpc.appIdentifier),
        ArpcCodec.writePascalString(arpc.osVersion),
        ArpcCodec.writeUInt32BE(arpc.functionId),
        ArpcCodec.writeUInt32BE(arpc.payload.length),
        arpc.payload
      ]);
    }
  };

  /* ─────────────────────────────────────────────────────────────
     6. WLOC 定位篡改核心 (WLOC Minimal Spoofer & Raw Scanner)
  ───────────────────────────────────────────────────────────── */
  function coordToInt(deg) {
    return Math.round(Number(deg) * 100000000);
  }

  // 最小改写 Location 子消息：仅替换已存在的 纬度(1)/经度(2)/水平精度(3)，原值透传其余所有字段
  function patchLocationRecord(locationBytes, config) {
    if (!locationBytes || locationBytes.length === 0) return locationBytes;
    var fields = ProtobufEngine.readFields(locationBytes);
    var hasLat = false;
    var hasLon = false;
    var i;

    for (i = 0; i < fields.length; i += 1) {
      if (fields[i].fieldNumber === 1 && fields[i].wireType === 0) hasLat = true;
      if (fields[i].fieldNumber === 2 && fields[i].wireType === 0) hasLon = true;
    }

    // 若无经纬度结构，原样放行，避免破坏响应结构
    if (!hasLat || !hasLon) {
      return locationBytes;
    }

    var parts = [];
    for (i = 0; i < fields.length; i += 1) {
      var f = fields[i];
      if (f.fieldNumber === 1 && f.wireType === 0) {
        parts.push(ProtobufEngine.makeVarintField(1, coordToInt(config.latitude)));
      } else if (f.fieldNumber === 2 && f.wireType === 0) {
        parts.push(ProtobufEngine.makeVarintField(2, coordToInt(config.longitude)));
      } else if (f.fieldNumber === 3 && f.wireType === 0) {
        parts.push(ProtobufEngine.makeVarintField(3, config.horizontalAccuracy));
      } else {
        parts.push(f.raw);
      }
    }
    return ByteUtils.concat(parts);
  }

  function patchWifiEntity(wifiBytes, config) {
    var fields = ProtobufEngine.readFields(wifiBytes);
    var parts = [];
    for (var i = 0; i < fields.length; i += 1) {
      var f = fields[i];
      if (f.fieldNumber === 2 && f.wireType === 2) {
        parts.push(ProtobufEngine.makeLengthDelimitedField(2, patchLocationRecord(f.valueBytes, config)));
      } else {
        parts.push(f.raw);
      }
    }
    return ByteUtils.concat(parts);
  }

  function patchCellEntity(cellBytes, config) {
    var fields = ProtobufEngine.readFields(cellBytes);
    var parts = [];
    for (var i = 0; i < fields.length; i += 1) {
      var f = fields[i];
      if (f.fieldNumber === 5 && f.wireType === 2) {
        parts.push(ProtobufEngine.makeLengthDelimitedField(5, patchLocationRecord(f.valueBytes, config)));
      } else {
        parts.push(f.raw);
      }
    }
    return ByteUtils.concat(parts);
  }

  function patchWlocPayload(payloadBytes, config) {
    var fields = ProtobufEngine.readFields(payloadBytes);
    var parts = [];
    var wifiCount = 0;
    var cellCount = 0;

    for (var i = 0; i < fields.length; i += 1) {
      var f = fields[i];
      if (f.fieldNumber === 2 && f.wireType === 2) {
        parts.push(ProtobufEngine.makeLengthDelimitedField(2, patchWifiEntity(f.valueBytes, config)));
        wifiCount += 1;
      } else if (CELL_RESPONSE_TAGS[f.fieldNumber] && f.wireType === 2) {
        parts.push(ProtobufEngine.makeLengthDelimitedField(f.fieldNumber, patchCellEntity(f.valueBytes, config)));
        cellCount += 1;
      } else {
        // 关键：其余根级字段（包括 3, 4, 33 等）全量原样透传，不丢弃！
        parts.push(f.raw);
      }
    }

    return {
      payload: ByteUtils.concat(parts),
      wifiCount: wifiCount,
      cellCount: cellCount
    };
  }

  function buildSyntheticResponse(payload, prefix) {
    var pref = prefix || APPLE_SYNTHETIC_PREFIX;
    return ByteUtils.concat([pref, ArpcCodec.writeUInt16BE(payload.length), payload]);
  }

  function looksLikeWlocPayload(bytes) {
    if (!bytes || bytes.length === 0) return false;
    var tag = bytes[0];
    var fieldNumber = tag >> 3;
    var wireType = tag & 0x07;
    return fieldNumber > 0 && (wireType === 0 || wireType === 2);
  }

  // 滑窗特征扫描兜底：当遭遇未知前缀头部时，自动在 0~256 字节内滑窗定位 WLOC protobuf
  function scanPatchRawBuffer(responseBytes, config) {
    if (!responseBytes || responseBytes.length < 8) {
      throw new Error("Response buffer too short for raw scan");
    }

    var offsets = [];
    var i;
    var frameLimit = Math.min(96, Math.max(0, responseBytes.length - 10));
    for (i = 0; i <= frameLimit; i += 2) offsets.push(i);
    var rawLimit = Math.min(256, Math.max(0, responseBytes.length - 4));
    for (i = 0; i <= rawLimit; i += 1) {
      if (offsets.indexOf(i) < 0) offsets.push(i);
    }

    for (i = 0; i < offsets.length; i += 1) {
      var offset = offsets[i];
      try {
        var slice = responseBytes.subarray(offset);
        if (!looksLikeWlocPayload(slice)) continue;
        var patched = patchWlocPayload(slice, config);
        if (patched.wifiCount > 0 || patched.cellCount > 0) {
          return {
            response: buildSyntheticResponse(patched.payload),
            payload: patched.payload,
            wifiCount: patched.wifiCount,
            cellCount: patched.cellCount,
            kind: "raw",
            offset: offset
          };
        }
      } catch (e) {
        // Continue scanning
      }
    }
    throw new Error("Raw scan found no valid patchable WLOC payload");
  }

  function extractEnvelope(responseBytes) {
    if (!responseBytes || responseBytes.length < 2) {
      throw new Error("Response body is empty or too short");
    }

    // 1. Prefixed synthetic format
    if (responseBytes.length >= 10 && responseBytes[0] === 0x00 && responseBytes[1] === 0x01 && responseBytes[6] === 0x00 && responseBytes[7] === 0x00) {
      var payloadLen = ArpcCodec.readUInt16BE(responseBytes, 8);
      if (payloadLen > 0 && 10 + payloadLen <= responseBytes.length) {
        var payloadCandidate = responseBytes.subarray(10, 10 + payloadLen);
        if (ProtobufEngine.safeReadFields(payloadCandidate) !== null) {
          return {
            kind: "synthetic",
            payload: payloadCandidate,
            prefix: responseBytes.subarray(0, 8),
            suffix: responseBytes.subarray(10 + payloadLen)
          };
        }
      }
    }

    // 2. Structured ARPC format
    try {
      var arpc = ArpcCodec.parse(responseBytes);
      if (arpc.payload.length > 0 && ProtobufEngine.safeReadFields(arpc.payload) !== null) {
        return {
          kind: "arpc",
          payload: arpc.payload,
          arpc: arpc
        };
      }
    } catch (e) {
      // Not standard ARPC
    }

    // 3. Marker signature format
    var markerIdx = ByteUtils.findSequence(responseBytes, APPLE_MARKER_SIGNATURE);
    if (markerIdx >= 0) {
      var lenOffset = markerIdx + APPLE_MARKER_SIGNATURE.length;
      if (lenOffset + 2 <= responseBytes.length) {
        var markerLen = ArpcCodec.readUInt16BE(responseBytes, lenOffset);
        var pOffset = lenOffset + 2;
        if (markerLen > 0 && pOffset + markerLen <= responseBytes.length) {
          var markerPayload = responseBytes.subarray(pOffset, pOffset + markerLen);
          if (ProtobufEngine.safeReadFields(markerPayload) !== null) {
            return {
              kind: "marker",
              payload: markerPayload,
              prefix: responseBytes.subarray(0, markerIdx),
              markerAndLen: responseBytes.subarray(markerIdx, pOffset),
              suffix: responseBytes.subarray(pOffset + markerLen)
            };
          }
        }
      }
    }

    // 4. Bare protobuf
    if (looksLikeWlocPayload(responseBytes) && ProtobufEngine.safeReadFields(responseBytes) !== null) {
      return {
        kind: "bare",
        payload: responseBytes
      };
    }

    return null;
  }

  function spoofAppleResponse(responseBytes, rawConfig) {
    var config = normalizeConfig(rawConfig);
    var extraction = null;
    var strictError = null;

    try {
      extraction = extractEnvelope(responseBytes);
    } catch (err) {
      strictError = err;
    }

    if (extraction) {
      var patched = patchWlocPayload(extraction.payload, config);
      if (patched.wifiCount > 0 || patched.cellCount > 0) {
        var finalResponse;
        if (extraction.kind === "arpc") {
          finalResponse = ArpcCodec.serialize({
            version: extraction.arpc.version,
            locale: extraction.arpc.locale,
            appIdentifier: extraction.arpc.appIdentifier,
            osVersion: extraction.arpc.osVersion,
            functionId: extraction.arpc.functionId,
            payload: patched.payload
          });
        } else if (extraction.kind === "marker") {
          var newLen = ArpcCodec.writeUInt16BE(patched.payload.length);
          finalResponse = ByteUtils.concat([
            extraction.prefix,
            extraction.markerAndLen.subarray(0, APPLE_MARKER_SIGNATURE.length),
            newLen,
            patched.payload,
            extraction.suffix
          ]);
        } else {
          finalResponse = buildSyntheticResponse(patched.payload, extraction.prefix);
        }

        return {
          response: finalResponse,
          payload: patched.payload,
          wifiCount: patched.wifiCount,
          cellCount: patched.cellCount,
          kind: extraction.kind,
          prefix: extraction.prefix ? ByteUtils.toHex(extraction.prefix, 8) : ""
        };
      }
      strictError = new Error("No patchable location submessages via " + extraction.kind);
    }

    // 触发滑窗扫描兜底
    var rawScan = scanPatchRawBuffer(responseBytes, config);
    return {
      response: rawScan.response,
      payload: rawScan.payload,
      wifiCount: rawScan.wifiCount,
      cellCount: rawScan.cellCount,
      kind: rawScan.kind,
      offset: rawScan.offset,
      strictError: strictError ? strictError.message : null
    };
  }

  /* ─────────────────────────────────────────────────────────────
     7. 参数解析与配置归一化 (Arguments & Config Normalization)
  ───────────────────────────────────────────────────────────── */
  function normalizeConfig(input) {
    var cfg = {};
    input = input || {};
    for (var k in CONFIG_DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, k)) {
        cfg[k] = CONFIG_DEFAULTS[k];
      }
    }
    for (var key in input) {
      if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined) {
        cfg[key] = input[key];
      }
    }
    cfg.latitude = Number(cfg.latitude);
    cfg.longitude = Number(cfg.longitude);
    cfg.horizontalAccuracy = Number(cfg.horizontalAccuracy) || 39;
    cfg.verticalAccuracy = Number(cfg.verticalAccuracy) || 1000;
    cfg.altitude = Number(cfg.altitude) || 44;
    cfg.debug = cfg.debug === true || cfg.debug === "true";
    cfg.failOpen = cfg.failOpen !== false && cfg.failOpen !== "false";
    return cfg;
  }

  function parseArgumentString(argStr) {
    var out = {};
    if (!argStr || typeof argStr !== "string") return out;

    var configUrlIdx = argStr.indexOf("configUrl=");
    if (configUrlIdx >= 0) {
      var after = argStr.slice(configUrlIdx + 10);
      var endIdx = after.search(/[&,\s]/);
      if (endIdx < 0) {
        out.configUrl = after;
        argStr = argStr.slice(0, configUrlIdx);
      } else {
        out.configUrl = after.slice(0, endIdx);
        argStr = argStr.slice(0, configUrlIdx) + after.slice(endIdx);
      }
    }

    var tokens = argStr.split(/[&,]/);
    for (var i = 0; i < tokens.length; i += 1) {
      var token = tokens[i].trim();
      if (!token) continue;
      var eq = token.indexOf("=");
      if (eq > 0) {
        var key = token.slice(0, eq).trim();
        var val = token.slice(eq + 1).trim();
        out[key] = val;
      }
    }
    return out;
  }

  /* ─────────────────────────────────────────────────────────────
     8. Shadowrocket 运行时接入 (Shadowrocket Runtime Integration)
  ───────────────────────────────────────────────────────────── */
  function fetchRemoteConfig(url, callback) {
    if (!url || typeof $httpClient === "undefined") {
      callback(null);
      return;
    }
    $httpClient.get({ url: url, timeout: 5 }, function (err, resp, data) {
      if (err || !data || (resp && resp.status >= 400)) {
        callback(null);
        return;
      }
      try {
        var json = JSON.parse(data);
        callback(json);
      } catch (e) {
        callback(null);
      }
    });
  }

  function runShadowrocket() {
    var hasResponse = typeof $response !== "undefined" && $response != null;
    var hasRequest = typeof $request !== "undefined" && $request != null;

    if (!hasResponse && !hasRequest) {
      return;
    }

    var scriptArgs = typeof $argument === "string" ? parseArgumentString($argument) : {};
    var config = normalizeConfig(scriptArgs);

    function passThrough() {
      $done({});
    }

    function completeResponse(bodyBytes, wifiCount, cellCount) {
      var headers = ($response && $response.headers) ? $response.headers : {};
      delete headers["Content-Encoding"];
      delete headers["content-encoding"];
      headers["Content-Length"] = String(bodyBytes.length);
      headers["X-Location-Spoofer"] = "active";
      headers["X-Location-Spoofer-Wifi"] = String(wifiCount);
      headers["X-Location-Spoofer-Cell"] = String(cellCount);

      $done({
        response: {
          status: 200,
          headers: headers,
          body: bodyBytes
        }
      });
    }

    function processRewrite(activeConfig) {
      try {
        var rawBody = ByteUtils.toUint8Array(($response && $response.body != null) ? $response.body : ($response && $response.bodyBytes));
        if (!rawBody || rawBody.length < 2) {
          passThrough();
          return;
        }

        var result = spoofAppleResponse(rawBody, activeConfig);
        if (activeConfig.debug) {
          console.log("[Location Spoofer] Patched " + result.wifiCount + " Wi-Fi, " + result.cellCount + " Cell. Format: " + result.kind);
        }
        completeResponse(result.response, result.wifiCount, result.cellCount);
      } catch (err) {
        if (activeConfig.debug) {
          console.log("[Location Spoofer] Failed: " + err.message);
        }
        if (activeConfig.failOpen) {
          passThrough();
        } else {
          $done({
            response: {
              status: "HTTP/1.1 500 Internal Server Error",
              headers: { "Content-Type": "text/plain" },
              body: "Location spoofing failed: " + err.message
            }
          });
        }
      }
    }

    if (config.configUrl) {
      fetchRemoteConfig(config.configUrl, function (remoteData) {
        if (remoteData) {
          if (remoteData.latitude != null) config.latitude = Number(remoteData.latitude);
          if (remoteData.longitude != null) config.longitude = Number(remoteData.longitude);
          if (remoteData.horizontalAccuracy != null) config.horizontalAccuracy = Number(remoteData.horizontalAccuracy);
          if (remoteData.verticalAccuracy != null) config.verticalAccuracy = Number(remoteData.verticalAccuracy);
          if (remoteData.altitude != null) config.altitude = Number(remoteData.altitude);
        }
        processRewrite(config);
      });
    } else {
      processRewrite(config);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     9. 模块导出与入口 (Module Export & Entry Point)
  ───────────────────────────────────────────────────────────── */
  var api = {
    CONFIG_DEFAULTS: CONFIG_DEFAULTS,
    APPLE_SYNTHETIC_PREFIX: APPLE_SYNTHETIC_PREFIX,
    APPLE_MARKER_SIGNATURE: APPLE_MARKER_SIGNATURE,
    ByteUtils: ByteUtils,
    Varint64: Varint64,
    ProtobufEngine: ProtobufEngine,
    ArpcCodec: ArpcCodec,
    coordToInt: coordToInt,
    normalizeConfig: normalizeConfig,
    parseArgumentString: parseArgumentString,
    patchLocationRecord: patchLocationRecord,
    patchWifiEntity: patchWifiEntity,
    patchCellEntity: patchCellEntity,
    patchWlocPayload: patchWlocPayload,
    buildSyntheticResponse: buildSyntheticResponse,
    scanPatchRawBuffer: scanPatchRawBuffer,
    extractEnvelope: extractEnvelope,
    spoofAppleResponse: spoofAppleResponse,
    uint64ToSignedNumber: Varint64.toSignedNumber,
    // 兼容测试套件别名
    concatBytes: ByteUtils.concat,
    decodeVarint: Varint64.decode,
    encodeVarintUnsigned: Varint64.encodeUnsigned,
    encodeVarintSignedInt64: Varint64.encodeSigned,
    makeVarintField: ProtobufEngine.makeVarintField,
    makeLengthDelimitedField: ProtobufEngine.makeLengthDelimitedField,
    parseFields: ProtobufEngine.readFields,
    buildAppleWLocResponse: buildSyntheticResponse
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    runShadowrocket();
  }
}());
