/*
 * 拦截 Apple /clls/wloc 接口的回应，解 ARPC 封包，改 WiFi 热点和基站坐标，
 * 再按 Apple 的格式封回去返回给系统。
 *
 * 主要流程：
 *   ARPC 拆包 → protobuf 解字段 → 替换 Location 子消息的坐标/精度/运动状态
 *   → protobuf 重新打包 → 按原格式（ARPC / marker / synthetic）封回
 */
(function () {
  "use strict";

  var DEFAULT_CONFIG = {
    enabled: true,
    mode: "response",
    latitude: 37.3349,
    longitude: -122.00902,
    horizontalAccuracy: 39,
    verticalAccuracy: 1000,
    altitude: 530,
    unknownValue4: 3,
    motionActivityType: 63,
    motionActivityConfidence: 467,
    failOpen: true,
    debug: false,
    dumpRaw: false,
    dumpHeaders: false,
    prepareHeaders: false,
    rawLimit: 0
  };

  // Prefix prepended to a SPOOFED (synthesized) response. Mirrors the original Go
  // `initialBytes = 0001000000010000` from main.go:253.
  var APPLE_WLOC_PREFIX = bytesFromArray([0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);

  // Stable marker that precedes the AppleWLoc protobuf inside a REAL Apple /clls/wloc
  // response. After the marker come 2 bytes (uint16 BE payload length) then the payload.
  var APPLE_WLOC_MARKER = bytesFromArray([0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
  var ROOT_DROP_FIELDS = { 3: true, 4: true, 33: true };
  var CELL_RESPONSE_FIELDS = { 22: true, 24: true };
  var LOCATION_REPLACED_FIELDS = {
    1: true,
    2: true,
    3: true,
    4: true,
    5: true,
    6: true,
    11: true,
    12: true
  };

  function bytesFromArray(values) {
    return new Uint8Array(values);
  }

  function concatBytes(parts) {
    var total = 0;
    var i;
    for (i = 0; i < parts.length; i += 1) {
      total += parts[i].length;
    }

    var out = new Uint8Array(total);
    var offset = 0;
    for (i = 0; i < parts.length; i += 1) {
      out.set(parts[i], offset);
      offset += parts[i].length;
    }
    return out;
  }

  function bytesEqualPrefix(bytes, prefix) {
    if (!bytes || bytes.length < prefix.length) {
      return false;
    }
    for (var i = 0; i < prefix.length; i += 1) {
      if (bytes[i] !== prefix[i]) {
        return false;
      }
    }
    return true;
  }

  // Search for a byte sequence within bytes; returns first index or -1.
  // Searches forward to prefer the earliest (most likely correct) match.
  function findBytes(bytes, marker) {
    if (!bytes || !marker || marker.length === 0) {
      return -1;
    }
    for (var i = 0; i <= bytes.length - marker.length; i += 1) {
      var ok = true;
      for (var j = 0; j < marker.length; j += 1) {
        if (bytes[i + j] !== marker[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return i;
      }
    }
    return -1;
  }

  // Try to parse bytes as protobuf fields. Returns fields array or null on failure.
  function tryParseFields(bytes) {
    try {
      if (!bytes || bytes.length === 0) {
        return null;
      }
      var fields = parseFields(bytes);
      return fields.length > 0 ? fields : null;
    } catch (e) {
      return null;
    }
  }

  function binaryStringToBytes(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i += 1) {
      out[i] = value.charCodeAt(i) & 0xff;
    }
    return out;
  }

  function bytesToBinaryString(bytes) {
    var chunkSize = 0x8000;
    var chunks = [];
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, i + chunkSize);
      chunks.push(String.fromCharCode.apply(null, Array.prototype.slice.call(chunk)));
    }
    return chunks.join("");
  }

  function bytesToBase64(bytes) {
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
  }

  function hexPreview(bytes, limit) {
    if (!bytes) {
      return "<none>";
    }
    var out = [];
    var max = Math.min(bytes.length, limit || 16);
    for (var i = 0; i < max; i += 1) {
      out.push(("0" + bytes[i].toString(16)).slice(-2));
    }
    return out.join("");
  }

  function bodyToBytes(body) {
    if (body == null) {
      return null;
    }
    if (body instanceof Uint8Array) {
      return body;
    }
    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
      return new Uint8Array(body);
    }
    if (typeof body === "string") {
      return binaryStringToBytes(body);
    }
    if (typeof body === "object" && typeof body.length === "number") {
      return new Uint8Array(body);
    }
    if (typeof body === "object" && body.bytes && typeof body.bytes.length === "number") {
      return new Uint8Array(body.bytes);
    }
    if (typeof body === "object" && body.data && typeof body.data.length === "number") {
      return new Uint8Array(body.data);
    }
    return null;
  }

  function messageBodyToBytes(message) {
    if (!message) {
      return null;
    }
    return (
      bodyToBytes(message.bodyBytes) ||
      bodyToBytes(message.body) ||
      bodyToBytes(message.rawBody) ||
      bodyToBytes(message.binaryBody)
    );
  }

  function readUInt16BE(bytes, offset) {
    if (offset + 2 > bytes.length) {
      throw new Error("uint16 out of range");
    }
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function readUInt32BE(bytes, offset) {
    if (offset + 4 > bytes.length) {
      throw new Error("uint32 out of range");
    }
    return (
      (bytes[offset] * 0x1000000) +
      ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
    ) >>> 0;
  }

  function writeUInt16BE(value) {
    if (value < 0 || value > 0xffff) {
      throw new Error("uint16 value out of range: " + value);
    }
    return bytesFromArray([(value >> 8) & 0xff, value & 0xff]);
  }

  function writeUInt32BE(value) {
    return bytesFromArray([
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff
    ]);
  }

  function asciiBytes(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i += 1) {
      out[i] = value.charCodeAt(i) & 0x7f;
    }
    return out;
  }

  function encodeVarintUnsigned(value) {
    var v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n) {
      throw new Error("negative unsigned varint");
    }

    var out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return bytesFromArray(out);
  }

  function encodeVarintSignedInt64(value) {
    var v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
    if (v < 0n) {
      v = BigInt.asUintN(64, v);
    }
    return encodeVarintUnsigned(v);
  }

  function decodeVarint(bytes, offset) {
    var result = 0n;
    var shift = 0n;
    var current = offset;

    while (current < bytes.length) {
      var b = bytes[current];
      current += 1;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        return { value: result, offset: current };
      }
      shift += 7n;
      if (shift > 70n) {
        throw new Error("varint too long");
      }
    }

    throw new Error("unterminated varint");
  }

  function makeKey(fieldNumber, wireType) {
    return encodeVarintUnsigned((BigInt(fieldNumber) << 3n) | BigInt(wireType));
  }

  function makeVarintField(fieldNumber, value) {
    return concatBytes([makeKey(fieldNumber, 0), encodeVarintSignedInt64(value)]);
  }

  function makeLengthDelimitedField(fieldNumber, payload) {
    return concatBytes([makeKey(fieldNumber, 2), encodeVarintUnsigned(payload.length), payload]);
  }

  function parseFields(bytes) {
    var fields = [];
    var offset = 0;

    while (offset < bytes.length) {
      var keyStart = offset;
      var key = decodeVarint(bytes, offset);
      offset = key.offset;

      var fieldNumber = Number(key.value >> 3n);
      var wireType = Number(key.value & 0x7n);
      if (fieldNumber === 0) {
        throw new Error("protobuf field number 0");
      }

      var valueStart = offset;
      var valueEnd;
      if (wireType === 0) {
        valueEnd = decodeVarint(bytes, offset).offset;
      } else if (wireType === 1) {
        valueEnd = offset + 8;
      } else if (wireType === 2) {
        var lengthInfo = decodeVarint(bytes, offset);
        var length = Number(lengthInfo.value);
        valueStart = lengthInfo.offset;
        valueEnd = valueStart + length;
      } else if (wireType === 5) {
        valueEnd = offset + 4;
      } else {
        throw new Error("unsupported protobuf wire type: " + wireType);
      }

      if (valueEnd > bytes.length) {
        throw new Error("protobuf field exceeds buffer");
      }

      fields.push({
        fieldNumber: fieldNumber,
        wireType: wireType,
        keyStart: keyStart,
        valueStart: valueStart,
        valueEnd: valueEnd,
        end: valueEnd,
        raw: bytes.slice(keyStart, valueEnd),
        valueBytes: bytes.slice(valueStart, valueEnd)
      });
      offset = valueEnd;
    }

    return fields;
  }

  function firstFieldByNumber(fields, fieldNumber) {
    for (var i = 0; i < fields.length; i += 1) {
      if (fields[i].fieldNumber === fieldNumber) {
        return fields[i];
      }
    }
    return null;
  }

  function signedVarintFieldValue(field) {
    if (!field || field.wireType !== 0) {
      return null;
    }
    return BigInt.asIntN(64, decodeVarint(field.valueBytes, 0).value);
  }

  function locationSummary(locationPayload) {
    try {
      var fields = parseFields(locationPayload);
      var lat = signedVarintFieldValue(firstFieldByNumber(fields, 1));
      var lon = signedVarintFieldValue(firstFieldByNumber(fields, 2));
      if (lat == null || lon == null) {
        return "<missing>";
      }
      return (Number(lat) / 100000000).toFixed(8) + "," + (Number(lon) / 100000000).toFixed(8);
    } catch (err) {
      return "<parse-failed:" + err.message + ">";
    }
  }

  function patchedPayloadSummary(payload) {
    try {
      var rootFields = parseFields(payload);
      var parts = [];
      var wifi = firstFieldByNumber(rootFields, 2);
      if (wifi && wifi.wireType === 2) {
        var wifiLocation = firstFieldByNumber(parseFields(wifi.valueBytes), 2);
        parts.push("firstWifi=" + (wifiLocation ? locationSummary(wifiLocation.valueBytes) : "<missing>"));
      }
      var cell = firstCellResponseField(rootFields);
      if (cell && cell.wireType === 2) {
        var cellLocation = firstFieldByNumber(parseFields(cell.valueBytes), 5);
        parts.push("firstCell=" + (cellLocation ? locationSummary(cellLocation.valueBytes) : "<missing>"));
      }
      return parts.length ? parts.join(", ") : "no wifi/cell location fields";
    } catch (err) {
      return "summary failed: " + err.message;
    }
  }

  function isCellResponseField(fieldNumber) {
    return CELL_RESPONSE_FIELDS[fieldNumber] === true;
  }

  function firstCellResponseField(fields) {
    for (var i = 0; i < fields.length; i += 1) {
      if (isCellResponseField(fields[i].fieldNumber)) {
        return fields[i];
      }
    }
    return null;
  }

  function coordToInt(value) {
    // 使用 Math.trunc 精确匹配 Go: int64(coord * 1e8)
    return Math.trunc(Number(value) * 100000000);
  }

  function parseBoolean(value, defaultValue) {
    if (value === true || value === false) {
      return value;
    }
    if (typeof value === "string") {
      var normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
        return true;
      }
      if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
        return false;
      }
    }
    return defaultValue;
  }

  function normalizeConfig(input) {
    var cfg = {};
    var key;
    for (key in DEFAULT_CONFIG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) {
        cfg[key] = DEFAULT_CONFIG[key];
      }
    }
    input = input || {};
    for (key in input) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        cfg[key] = input[key];
      }
    }

    cfg.enabled = parseBoolean(cfg.enabled, true);
    cfg.failOpen = parseBoolean(cfg.failOpen, true);
    var mode = String(cfg.mode || "response").toLowerCase();
    cfg.mode = mode === "request" || mode === "prepare" || mode === "probe" || mode === "inspect" ? mode : "response";
    cfg.latitude = Number(cfg.latitude);
    cfg.longitude = Number(cfg.longitude);
    cfg.horizontalAccuracy = Math.trunc(Number(cfg.horizontalAccuracy));
    cfg.verticalAccuracy = Math.trunc(Number(cfg.verticalAccuracy));
    cfg.altitude = Math.trunc(Number(cfg.altitude));
    cfg.unknownValue4 = Math.trunc(Number(cfg.unknownValue4));
    cfg.motionActivityType = Math.trunc(Number(cfg.motionActivityType));
    cfg.motionActivityConfidence = Math.trunc(Number(cfg.motionActivityConfidence));
    cfg.dumpRaw = cfg.dumpRaw === true || String(cfg.dumpRaw).toLowerCase() === "true";
    cfg.dumpHeaders = cfg.dumpHeaders === true || String(cfg.dumpHeaders).toLowerCase() === "true";
    cfg.prepareHeaders = cfg.prepareHeaders === true || String(cfg.prepareHeaders).toLowerCase() === "true";
    cfg.rawLimit = Math.trunc(Number(cfg.rawLimit || 0));
    if (!Number.isFinite(cfg.rawLimit) || cfg.rawLimit < 0) {
      cfg.rawLimit = 0;
    }

    if (!Number.isFinite(cfg.latitude) || cfg.latitude < -90 || cfg.latitude > 90) {
      throw new Error("invalid latitude");
    }
    if (!Number.isFinite(cfg.longitude) || cfg.longitude < -180 || cfg.longitude > 180) {
      throw new Error("invalid longitude");
    }
    return cfg;
  }

  function patchLocation(locationPayload, config) {
    var parts = [];
    var fields = locationPayload.length ? parseFields(locationPayload) : [];
    for (var i = 0; i < fields.length; i += 1) {
      if (!LOCATION_REPLACED_FIELDS[fields[i].fieldNumber]) {
        parts.push(fields[i].raw);
      }
    }

    parts.push(makeVarintField(1, coordToInt(config.latitude)));
    parts.push(makeVarintField(2, coordToInt(config.longitude)));
    parts.push(makeVarintField(3, config.horizontalAccuracy));
    parts.push(makeVarintField(4, config.unknownValue4));
    parts.push(makeVarintField(5, config.altitude));
    parts.push(makeVarintField(6, config.verticalAccuracy));
    parts.push(makeVarintField(11, config.motionActivityType));
    parts.push(makeVarintField(12, config.motionActivityConfidence));
    return concatBytes(parts);
  }

  function patchWifiDevice(wifiPayload, config) {
    var fields = parseFields(wifiPayload);
    var parts = [];
    var patchedLocation = false;

    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (field.fieldNumber === 2 && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(2, patchLocation(field.valueBytes, config)));
        patchedLocation = true;
      } else {
        parts.push(field.raw);
      }
    }

    if (!patchedLocation) {
      parts.push(makeLengthDelimitedField(2, patchLocation(bytesFromArray([]), config)));
    }

    return concatBytes(parts);
  }

  function patchCellTower(cellPayload, config) {
    var fields = parseFields(cellPayload);
    var parts = [];
    var patchedLocation = false;

    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (field.fieldNumber === 5 && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(5, patchLocation(field.valueBytes, config)));
        patchedLocation = true;
      } else {
        parts.push(field.raw);
      }
    }

    if (!patchedLocation) {
      parts.push(makeLengthDelimitedField(5, patchLocation(bytesFromArray([]), config)));
    }

    return concatBytes(parts);
  }

  function patchAppleWLocPayload(payload, config) {
    var fields = parseFields(payload);
    var parts = [];
    var wifiCount = 0;
    var cellCount = 0;

    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (field.fieldNumber === 2 && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(2, patchWifiDevice(field.valueBytes, config)));
        wifiCount += 1;
      } else if (isCellResponseField(field.fieldNumber) && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(field.fieldNumber, patchCellTower(field.valueBytes, config)));
        cellCount += 1;
      } else if (!ROOT_DROP_FIELDS[field.fieldNumber]) {
        parts.push(field.raw);
      }
    }

    return { payload: concatBytes(parts), wifiCount: wifiCount, cellCount: cellCount };
  }

  function readPascalString(bytes, state) {
    var length = readUInt16BE(bytes, state.offset);
    state.offset += 2;
    if (state.offset + length > bytes.length) {
      throw new Error("ARPC pascal string exceeds buffer");
    }

    var chars = [];
    for (var i = 0; i < length; i += 1) {
      chars.push(String.fromCharCode(bytes[state.offset + i]));
    }
    state.offset += length;
    return chars.join("");
  }

  function writePascalString(value) {
    var bytes = asciiBytes(value);
    return concatBytes([writeUInt16BE(bytes.length), bytes]);
  }

  function parseArpc(bytes) {
    var state = { offset: 0 };
    var version = readUInt16BE(bytes, state.offset);
    state.offset += 2;
    var locale = readPascalString(bytes, state);
    var appIdentifier = readPascalString(bytes, state);
    var osVersion = readPascalString(bytes, state);
    var functionId = readUInt32BE(bytes, state.offset);
    state.offset += 4;
    var payloadLength = readUInt32BE(bytes, state.offset);
    state.offset += 4;

    if (state.offset + payloadLength > bytes.length) {
      throw new Error("ARPC payload exceeds buffer");
    }

    return {
      version: version,
      locale: locale,
      appIdentifier: appIdentifier,
      osVersion: osVersion,
      functionId: functionId,
      payload: bytes.slice(state.offset, state.offset + payloadLength)
    };
  }

  function serializeArpc(arpc) {
    return concatBytes([
      writeUInt16BE(arpc.version),
      writePascalString(arpc.locale),
      writePascalString(arpc.appIdentifier),
      writePascalString(arpc.osVersion),
      writeUInt32BE(arpc.functionId),
      writeUInt32BE(arpc.payload.length),
      arpc.payload
    ]);
  }

  function buildAppleWLocResponse(payload, prefix) {
    return concatBytes([prefix || APPLE_WLOC_PREFIX, writeUInt16BE(payload.length), payload]);
  }

  function extractPrefixedAppleWLocPayload(responseBytes) {
    if (!responseBytes || responseBytes.length < 10) {
      return null;
    }
    if (responseBytes[0] !== 0x00 || responseBytes[1] !== 0x01) {
      return null;
    }
    if (responseBytes[6] !== 0x00 || responseBytes[7] !== 0x00) {
      return null;
    }

    var payloadLength = readUInt16BE(responseBytes, 8);
    var payloadOffset = 10;
    if (payloadLength <= 0 || payloadOffset + payloadLength > responseBytes.length) {
      return null;
    }

    var payload = responseBytes.slice(payloadOffset, payloadOffset + payloadLength);
    if (tryParseFields(payload) === null) {
      return null;
    }

    return {
      kind: "synthetic",
      payload: payload,
      prefix: responseBytes.slice(0, 8),
      suffix: responseBytes.slice(payloadOffset + payloadLength)
    };
  }

  // Extract the AppleWLoc protobuf payload from a /clls/wloc response body.
  // Returns a typed result: { kind, payload, ... } so the caller can write back
  // in the correct format.
  //
  // Supported shapes:
  //   "arpc"      – Full ARPC envelope (same format as requests). The real Apple
  //                 response uses this. Contains arpc metadata for write-back.
  //   "synthetic" – Our own spoofed response: APPLE_WLOC_PREFIX (8 bytes) + uint16 len.
  //   "marker"    – Fallback: marker search 00 00 00 01 00 00 + uint16 len.
  //                 Keeps the prefix/suffix bytes for write-back.
  //   "bare"      – Bare protobuf payload (field tag 0x12 = wifi device, wire type 2).
  function extractAppleWLocPayload(responseBytes) {
    if (!responseBytes || responseBytes.length < 2) {
      throw new Error("Apple WLoc response too short");
    }

    // Shape 1: prefixed WLoc response. The original Go implementation emits
    // 0001000000010000, while Apple's live responses may use 0001000000030000.
    var prefixed = extractPrefixedAppleWLocPayload(responseBytes);
    if (prefixed) {
      return prefixed;
    }

    // Shape 2: ARPC envelope – try the proper structured parser first.
    // The Apple /clls/wloc response uses the same ARPC framing as the request.
    try {
      var arpc = parseArpc(responseBytes);
      if (arpc.payload.length > 0 && tryParseFields(arpc.payload) !== null) {
        return {
          kind: "arpc",
          payload: arpc.payload,
          arpc: arpc
        };
      }
    } catch (e) {
      // ARPC parse failed – continue with fallback strategies.
    }

    // Shape 3: marker search fallback. The ARPC functionId (00 00 00 01) may be
    // followed by uint16/uint32 payload length. Try to find and validate.
    var markerIdx = findBytes(responseBytes, APPLE_WLOC_MARKER);
    if (markerIdx >= 0) {
      var lenOffset = markerIdx + APPLE_WLOC_MARKER.length;
      if (lenOffset + 2 <= responseBytes.length) {
        var realLen = readUInt16BE(responseBytes, lenOffset);
        var realPayloadOffset = lenOffset + 2;
        if (realLen > 0 && realPayloadOffset + realLen <= responseBytes.length) {
          var candidatePayload = responseBytes.slice(realPayloadOffset, realPayloadOffset + realLen);
          // Only accept if the candidate parses as valid protobuf.
          if (tryParseFields(candidatePayload) !== null) {
            return {
              kind: "marker",
              payload: candidatePayload,
              prefix: responseBytes.slice(0, markerIdx),
              markerAndLen: responseBytes.slice(markerIdx, realPayloadOffset),
              suffix: responseBytes.slice(realPayloadOffset + realLen)
            };
          }
        }
      }
    }

    // Shape 4: bare protobuf payload (best effort).
    if (looksLikeAppleWLocPayload(responseBytes)) {
      return {
        kind: "bare",
        payload: responseBytes
      };
    }

    throw new Error("missing Apple WLoc response prefix");
  }

  // Heuristic: a valid AppleWLoc payload starts with a protobuf tag whose wire type
  // is 0 or 2 and field number is > 0. Field 2 (wifi) tag is 0x12.
  function looksLikeAppleWLocPayload(bytes) {
    if (!bytes || bytes.length === 0) {
      return false;
    }
    var tag = bytes[0];
    var fieldNumber = tag >> 3;
    var wireType = tag & 0x7;
    return fieldNumber > 0 && (wireType === 0 || wireType === 2);
  }

  function spoofArpcRequest(requestBytes, configInput) {
    var config = normalizeConfig(configInput);
    var arpc = parseArpc(requestBytes);
    var patched = patchAppleWLocPayload(arpc.payload, config);
    return {
      response: buildAppleWLocResponse(patched.payload),
      payload: patched.payload,
      wifiCount: patched.wifiCount,
      cellCount: patched.cellCount,
      arpc: arpc
    };
  }

  function spoofAppleResponse(responseBytes, configInput) {
    var config = normalizeConfig(configInput);
    var extraction = extractAppleWLocPayload(responseBytes);
    var patched = patchAppleWLocPayload(extraction.payload, config);
    var response;

    if (extraction.kind === "arpc") {
      // Write back in ARPC format, preserving the original envelope metadata.
      var arpcOut = {
        version: extraction.arpc.version,
        locale: extraction.arpc.locale,
        appIdentifier: extraction.arpc.appIdentifier,
        osVersion: extraction.arpc.osVersion,
        functionId: extraction.arpc.functionId,
        payload: patched.payload
      };
      response = serializeArpc(arpcOut);
    } else if (extraction.kind === "marker") {
      // Rebuild: original prefix + marker bytes + new uint16 len + patched payload + suffix.
      var newLenBytes = writeUInt16BE(patched.payload.length);
      response = concatBytes([
        extraction.prefix,
        extraction.markerAndLen.slice(0, APPLE_WLOC_MARKER.length),
        newLenBytes,
        patched.payload,
        extraction.suffix
      ]);
    } else {
      // synthetic / bare – use the simple prefix format.
      response = buildAppleWLocResponse(patched.payload, extraction.prefix);
    }

    return {
      response: response,
      payload: patched.payload,
      wifiCount: patched.wifiCount,
      cellCount: patched.cellCount,
      kind: extraction.kind,
      prefix: extraction.prefix ? hexPreview(extraction.prefix, 8) : ""
    };
  }

  function parseArgumentString(argument) {
    var result = {};
    if (!argument || typeof argument !== "string") {
      return result;
    }

    var tailKeys = [
      "debug",
      "mode",
      "enabled",
      "latitude",
      "longitude",
      "altitude",
      "address",
      "configHost",
      "configToken",
      "horizontalAccuracy",
      "verticalAccuracy",
      "unknownValue4",
      "motionActivityType",
      "motionActivityConfidence",
      "failOpen",
      "dumpRaw",
      "dumpHeaders",
      "prepareHeaders",
      "rawLimit"
    ];
    var configUrlKey = "configUrl=";
    var configUrlIdx = argument.indexOf(configUrlKey);
    if (configUrlIdx >= 0) {
      var valueStart = configUrlIdx + configUrlKey.length;
      var tail = argument.slice(valueStart);
      var end = -1;
      var i;
      for (i = 0; i < tailKeys.length; i += 1) {
        var marker = "&" + tailKeys[i] + "=";
        var pos = tail.indexOf(marker);
        if (pos >= 0 && (end < 0 || pos < end)) {
          end = pos;
        }
      }
      var configUrlValue = end >= 0 ? tail.slice(0, end) : tail;
      try {
        result.configUrl = decodeURIComponent(configUrlValue);
      } catch (err) {
        result.configUrl = configUrlValue;
      }
      argument = argument.slice(0, configUrlIdx) + (end >= 0 ? tail.slice(end + 1) : "");
    }

    var pairs = argument.split(/[&;]/);
    for (var j = 0; j < pairs.length; j += 1) {
      var part = pairs[j];
      if (!part) {
        continue;
      }
      var eq = part.indexOf("=");
      var key = eq >= 0 ? part.slice(0, eq) : part;
      var value = eq >= 0 ? part.slice(eq + 1) : "true";
      try {
        result[decodeURIComponent(key)] = decodeURIComponent(value);
      } catch (err2) {
        result[key] = value;
      }
    }
    return result;
  }

  function resolveConfigUrl(args) {
    args = args || {};
    var direct = String(args.configUrl || args.cfg || args.url || "").trim();
    if (direct) {
      return direct;
    }
    var host = String(args.configHost || "").trim().replace(/\/+$/, "");
    var token = String(args.configToken || "").trim();
    if (host && token) {
      return host + "/loc.json?token=" + encodeURIComponent(token);
    }
    return "";
  }

  function isPlaceholderValue(value) {
    return typeof value === "string" && /^\{[^}]+\}$/.test(value.trim());
  }

  function readPluginStoreArg(name) {
    if (typeof $persistentStore === "undefined" || !$persistentStore.read) {
      return null;
    }
    try {
      var value = $persistentStore.read(name);
      if (value == null || value === "") {
        return null;
      }
      return String(value);
    } catch (err) {
      return null;
    }
  }

  function enrichArgsFromPluginStore(args) {
    var keys = [
      "enabled",
      "latitude",
      "longitude",
      "altitude",
      "address",
      "configHost",
      "configToken",
      "configUrl",
      "debug"
    ];
    var i;
    args = args || {};
    for (i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var current = args[key];
      if (current == null || current === "" || isPlaceholderValue(current)) {
        var stored = readPluginStoreArg(key);
        if (stored != null && !isPlaceholderValue(stored)) {
          args[key] = stored;
        }
      }
    }
    return args;
  }

  function readScriptArguments() {
    var out = {};
    if (typeof $argument !== "undefined" && $argument != null) {
      if (typeof $argument === "string") {
        out = parseArgumentString($argument);
      } else if (typeof $argument === "object") {
        var key;
        for (key in $argument) {
          if (Object.prototype.hasOwnProperty.call($argument, key)) {
            var value = $argument[key];
            out[key] = value == null ? "" : String(value);
          }
        }
      } else {
        out = parseArgumentString(String($argument));
      }
    }
    return enrichArgsFromPluginStore(out);
  }

  function logScriptArguments(debug) {
    if (!debug) {
      return;
    }
    var args = readScriptArguments();
    var raw =
      typeof $argument === "undefined" || $argument == null
        ? "<none>"
        : typeof $argument === "object"
          ? JSON.stringify($argument)
          : String($argument);
    console.log("Location spoofer $argument raw: " + raw);
    console.log(
      "Location spoofer args parsed: lat=" +
        args.latitude +
        ", lng=" +
        args.longitude +
        ", configUrl=" +
        (resolveConfigUrl(args) || "<none>")
    );
  }

  function detectRuntime() {
    if (typeof $environment !== "undefined" && $environment && $environment.product) {
      return String($environment.product);
    }
    if (typeof $loon !== "undefined") {
      return "Loon";
    }
    return "Unknown";
  }

  function isLoonRuntime() {
    return detectRuntime() === "Loon";
  }

  function isGzipBytes(bytes) {
    return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  }

  function readGeocodeCache() {
    if (typeof $persistentStore === "undefined" || !$persistentStore.read) {
      return null;
    }
    try {
      var raw = $persistentStore.read("location_spoofer_geocode");
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function writeGeocodeCache(entry) {
    if (typeof $persistentStore === "undefined" || !$persistentStore.write) {
      return;
    }
    try {
      $persistentStore.write("location_spoofer_geocode", JSON.stringify(entry));
    } catch (err) {
      // ignore cache write failures
    }
  }

  function fetchElevation(lat, lng, callback) {
    if (typeof $httpClient === "undefined" || !$httpClient.get) {
      callback(null);
      return;
    }
    var url =
      "https://api.open-meteo.com/v1/elevation?latitude=" +
      encodeURIComponent(String(lat)) +
      "&longitude=" +
      encodeURIComponent(String(lng));
    $httpClient.get({ url: url, timeout: 4000 }, function (error, response, body) {
      if (error || !body) {
        callback(null);
        return;
      }
      try {
        var data = JSON.parse(body);
        if (data && data.elevation && data.elevation.length) {
          callback(Math.round(Number(data.elevation[0])));
          return;
        }
      } catch (err) {
        // ignore parse failures
      }
      callback(null);
    });
  }

  function geocodeAddress(address, debug, callback) {
    var query = String(address || "").trim();
    if (!query) {
      callback(null);
      return;
    }

    var cached = readGeocodeCache();
    if (cached && cached.address === query && Number.isFinite(Number(cached.latitude)) && Number.isFinite(Number(cached.longitude))) {
      if (debug) {
        console.log("Location spoofer geocode cache hit: " + query + " -> " + cached.latitude + "," + cached.longitude);
      }
      callback(cached);
      return;
    }

    if (typeof $httpClient === "undefined" || !$httpClient.get) {
      if (debug) {
        console.log("Location spoofer geocode skipped: $httpClient unavailable");
      }
      callback(null);
      return;
    }

    var url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=0&q=" +
      encodeURIComponent(query);
    $httpClient.get(
      {
        url: url,
        timeout: 8000,
        headers: { "User-Agent": "ios-location-spoofer/1.0 (Loon plugin)" }
      },
      function (error, response, body) {
        if (error || !body) {
          if (debug) {
            console.log("Location spoofer geocode failed: " + (error || "empty body"));
          }
          callback(null);
          return;
        }
        try {
          var results = JSON.parse(body);
          if (!results || !results.length) {
            if (debug) {
              console.log("Location spoofer geocode no result for: " + query);
            }
            callback(null);
            return;
          }
          var hit = results[0];
          var lat = Number(hit.lat);
          var lng = Number(hit.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            callback(null);
            return;
          }
          var entry = {
            address: query,
            latitude: lat,
            longitude: lng,
            displayName: hit.display_name || query
          };
          fetchElevation(lat, lng, function (altitude) {
            if (altitude != null) {
              entry.altitude = altitude;
            }
            writeGeocodeCache(entry);
            if (debug) {
              console.log(
                "Location spoofer geocode resolved: " +
                  query +
                  " -> " +
                  lat +
                  "," +
                  lng +
                  (altitude != null ? ", alt=" + altitude : "")
              );
            }
            callback(entry);
          });
        } catch (err) {
          if (debug) {
            console.log("Location spoofer geocode parse failed: " + err.message);
          }
          callback(null);
        }
      }
    );
  }

  function mergeConfig(base, extra) {
    var out = {};
    var key;
    for (key in base) {
      if (Object.prototype.hasOwnProperty.call(base, key)) {
        out[key] = base[key];
      }
    }
    extra = extra || {};
    for (key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        out[key] = extra[key];
      }
    }
    return out;
  }

  function decodeBase64(value) {
    if (typeof atob === "function") {
      return atob(value);
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(value, "base64").toString("utf8");
    }
    throw new Error("base64 decoder unavailable");
  }

  function configFromArgs(args) {
    var cfg = {};
    var scalarKeys = [
      "enabled",
      "mode",
      "latitude",
      "longitude",
      "address",
      "horizontalAccuracy",
      "verticalAccuracy",
      "altitude",
      "unknownValue4",
      "motionActivityType",
      "motionActivityConfidence",
      "failOpen",
      "debug",
      "dumpRaw",
      "dumpHeaders",
      "prepareHeaders",
      "rawLimit"
    ];

    if (args.config) {
      cfg = mergeConfig(cfg, JSON.parse(args.config));
    }
    if (args.configBase64) {
      cfg = mergeConfig(cfg, JSON.parse(decodeBase64(args.configBase64)));
    }
    for (var i = 0; i < scalarKeys.length; i += 1) {
      var key = scalarKeys[i];
      if (Object.prototype.hasOwnProperty.call(args, key)) {
        cfg[key] = args[key];
      }
    }
    return cfg;
  }

  function readRemoteConfigCache(url) {
    if (!url || typeof $persistentStore === "undefined" || !$persistentStore.read) {
      return null;
    }
    try {
      var raw = $persistentStore.read("location_spoofer_remote_cfg");
      if (!raw) {
        return null;
      }
      var entry = JSON.parse(raw);
      if (!entry || entry.url !== url || !entry.data) {
        return null;
      }
      if (Date.now() - entry.ts > 300000) {
        return null;
      }
      return entry.data;
    } catch (err) {
      return null;
    }
  }

  function writeRemoteConfigCache(url, data) {
    if (!url || typeof $persistentStore === "undefined" || !$persistentStore.write) {
      return;
    }
    try {
      $persistentStore.write(
        "location_spoofer_remote_cfg",
        JSON.stringify({ url: url, data: data, ts: Date.now() })
      );
    } catch (err) {
      // ignore cache write failures
    }
  }

  function fetchRemoteConfig(url, timeout, debug, callback) {
    if (!url || typeof $httpClient === "undefined" || !$httpClient.get) {
      callback(null, "http client unavailable");
      return;
    }
    $httpClient.get({ url: url, timeout: timeout || 3000 }, function (error, response, body) {
      if (error || !body) {
        callback(null, error || "empty body");
        return;
      }
      try {
        callback(JSON.parse(body), null);
      } catch (err) {
        callback(null, err.message);
      }
    });
  }

  function refreshRemoteConfigCache(url, debug) {
    fetchRemoteConfig(url, 5000, debug, function (data, err) {
      if (data) {
        writeRemoteConfigCache(url, data);
        return;
      }
      if (debug) {
        console.log("Location spoofer remote config refresh failed: " + err);
      }
    });
  }

  function applyAddressFromCache(cfg, address, debug) {
    if (!address) {
      return;
    }
    var cached = readGeocodeCache();
    if (cached && cached.address === address && Number.isFinite(Number(cached.latitude)) && Number.isFinite(Number(cached.longitude))) {
      cfg.latitude = cached.latitude;
      cfg.longitude = cached.longitude;
      if (cached.altitude != null) {
        cfg.altitude = cached.altitude;
      }
      if (debug) {
        console.log("Location spoofer geocode cache hit: " + address);
      }
      return;
    }
    if (debug) {
      console.log("Location spoofer geocode cache miss: " + address + " (use manual lat/lng until cron refreshes)");
    }
  }

  function loadRuntimeConfigSync() {
    var args = readScriptArguments();
    var cfg = mergeConfig(DEFAULT_CONFIG, configFromArgs(args));
    var configUrl = resolveConfigUrl(args);
    var debug = parseBoolean(cfg.debug, false);
    var address = String(args.address || "").trim();

    applyAddressFromCache(cfg, address, debug);

    if (configUrl) {
      var remoteCfg = readRemoteConfigCache(configUrl);
      if (remoteCfg) {
        cfg = mergeConfig(cfg, remoteCfg);
        if (debug) {
          console.log(
            "Location spoofer remote config cache hit -> " +
              remoteCfg.latitude +
              "," +
              remoteCfg.longitude
          );
        }
      }
    }

    return { cfg: cfg, configUrl: configUrl, debug: debug };
  }

  function loadRuntimeConfig(callback) {
    var loaded = loadRuntimeConfigSync();
    var cfg = loaded.cfg;
    var configUrl = loaded.configUrl;
    var debug = loaded.debug;

    function finish() {
      try {
        callback(normalizeConfig(cfg));
      } catch (err) {
        if (debug) {
          console.log("Location spoofer config invalid: " + err.message + " | cfg lat/lng=" + cfg.latitude + "," + cfg.longitude);
        }
        if (!Number.isFinite(Number(cfg.latitude)) || !Number.isFinite(Number(cfg.longitude))) {
          cfg.latitude = DEFAULT_CONFIG.latitude;
          cfg.longitude = DEFAULT_CONFIG.longitude;
        }
        callback(normalizeConfig(cfg));
      }
    }

    logScriptArguments(debug);

    if (!configUrl) {
      finish();
      return;
    }

    if (readRemoteConfigCache(configUrl)) {
      refreshRemoteConfigCache(configUrl, debug);
      finish();
      return;
    }

    if (debug) {
      console.log("Location spoofer remote config fetching: " + configUrl);
    }
    fetchRemoteConfig(configUrl, 3000, debug, function (data, err) {
      if (data) {
        writeRemoteConfigCache(configUrl, data);
        cfg = mergeConfig(cfg, data);
        if (debug) {
          console.log(
            "Location spoofer remote config loaded -> " + data.latitude + "," + data.longitude
          );
        }
      } else if (debug) {
        console.log("Location spoofer remote config fetch failed: " + err + " (using manual lat/lng)");
      }
      finish();
    });
  }

  function runMaintenanceCron() {
    var args = readScriptArguments();
    var debug = parseBoolean(args.debug, false);
    var pending = 0;

    function maybeDone() {
      pending -= 1;
      if (pending <= 0) {
        $done({});
      }
    }

    var configUrl = resolveConfigUrl(args);
    if (configUrl) {
      pending += 1;
      fetchRemoteConfig(configUrl, 8000, debug, function (data, err) {
        if (data) {
          writeRemoteConfigCache(configUrl, data);
          if (debug) {
            console.log(
              "Location spoofer config cron cached -> " + data.latitude + "," + data.longitude
            );
          }
        } else if (debug) {
          console.log("Location spoofer config cron failed: " + err);
        }
        maybeDone();
      });
    }

    var address = String(args.address || "").trim();
    if (address) {
      pending += 1;
      geocodeAddress(address, debug, function () {
        maybeDone();
      });
    }

    if (pending === 0) {
      $done({});
    }
  }

  function runGeocodeCron() {
    runMaintenanceCron();
  }

  function headersWithBinaryBody(sourceHeaders, length) {
    var headers = {};
    var key;
    sourceHeaders = sourceHeaders || {};
    for (key in sourceHeaders) {
      if (Object.prototype.hasOwnProperty.call(sourceHeaders, key)) {
        var lower = key.toLowerCase();
        if (lower !== "content-length" && lower !== "content-encoding" && lower !== "transfer-encoding") {
          headers[key] = sourceHeaders[key];
        }
      }
    }
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Length"] = String(length);
    return headers;
  }

  function setHeader(headers, name, value) {
    headers = headers || {};
    var lower = name.toLowerCase();
    var existingKey = null;
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === lower) {
        existingKey = key;
        break;
      }
    }
    headers[existingKey || name] = value;
    return headers;
  }

  function prepareRequestHeaders(headers) {
    return setHeader(headers || {}, "Accept-Encoding", "identity");
  }

  function donePreparedRequestPassThrough() {
    var headers = prepareRequestHeaders((typeof $request !== "undefined" && $request.headers) || {});
    $done({
      headers: headers
    });
  }

  // Decode an HTTP response body that may be gzip/deflate/br encoded.
  // Shadowrocket/Surge expose $utils.ungzip; Loon falls back to DecompressionStream.
  function decompressBody(body, contentEncoding) {
    if (body == null) {
      return body;
    }
    var enc = contentEncoding ? String(contentEncoding).toLowerCase() : "";
    if (enc === "identity" || enc === "") {
      return body;
    }
    try {
      if (enc.indexOf("gzip") >= 0 && typeof $utils !== "undefined" && $utils.ungzip) {
        return $utils.ungzip(body);
      }
      if (enc.indexOf("deflate") >= 0 && typeof $utils !== "undefined" && $utils.inflate) {
        return $utils.inflate(body);
      }
      if (enc.indexOf("br") >= 0 && typeof $utils !== "undefined" && $utils.brotliDecompress) {
        return $utils.brotliDecompress(body);
      }
    } catch (err) {
      if (typeof console !== "undefined") {
        console.log("Location spoofer decompress failed (" + enc + "): " + err.message);
      }
    }
    return body;
  }

  function prepareResponseBodySync(config) {
    var respHeaders = ($response && $response.headers) || {};
    var contentEncoding = headerValue(respHeaders, "Content-Encoding");
    var rawRespBody = $response && ($response.body != null ? $response.body : $response.bodyBytes);
    logHttpDump("response-wire-original", $response, config);
    logRawDump("response-wire-original", bodyToBytes(rawRespBody), config);

    var bytes = bodyToBytes(rawRespBody);
    if (!bytes || bytes.length < 2) {
      return;
    }

    if (isGzipBytes(bytes) || (contentEncoding && String(contentEncoding).toLowerCase().indexOf("gzip") >= 0)) {
      var decoded = bodyToBytes(decompressBody(rawRespBody, contentEncoding || "gzip"));
      if (decoded && decoded.length > 2 && !isGzipBytes(decoded)) {
        $response.body = decoded;
        if (config.debug) {
          console.log("Location spoofer decompressed body: " + bytes.length + " -> " + decoded.length + " bytes");
        }
        return;
      }
      if (config.debug) {
        console.log(
          "Location spoofer gzip body still compressed (len=" +
            bytes.length +
            "); ensure http-request prepare script is enabled"
        );
      }
      return;
    }

    if (contentEncoding) {
      var plain = bodyToBytes(decompressBody(rawRespBody, contentEncoding));
      if (plain) {
        $response.body = plain;
      }
    }
  }

  function headerValue(headers, name) {
    if (!headers) {
      return undefined;
    }
    var lower = name.toLowerCase();
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === lower) {
        return headers[key];
      }
    }
    return undefined;
  }

  function donePassThrough() {
    $done({});
  }

  function valueType(value) {
    if (value == null) {
      return String(value);
    }
    if (value instanceof Uint8Array) {
      return "Uint8Array";
    }
    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
      return "ArrayBuffer";
    }
    return typeof value;
  }

  function valueLength(value) {
    if (value == null) {
      return 0;
    }
    if (typeof value === "string" || typeof value.length === "number") {
      return value.length;
    }
    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
      return value.byteLength;
    }
    return 0;
  }

  function objectKeys(value) {
    if (!value || typeof value !== "object") {
      return "";
    }
    var keys = [];
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        keys.push(key);
      }
    }
    return keys.join(",");
  }

  function fieldHistogram(fields) {
    var counts = {};
    var order = [];
    for (var i = 0; i < fields.length; i += 1) {
      var key = String(fields[i].fieldNumber) + "/" + String(fields[i].wireType);
      if (!counts[key]) {
        counts[key] = 0;
        order.push(key);
      }
      counts[key] += 1;
    }
    var parts = [];
    for (var j = 0; j < order.length; j += 1) {
      parts.push(order[j] + "x" + counts[order[j]]);
    }
    return parts.join(",");
  }

  function countFields(fields, fieldNumber) {
    var count = 0;
    for (var i = 0; i < fields.length; i += 1) {
      if (fields[i].fieldNumber === fieldNumber) {
        count += 1;
      }
    }
    return count;
  }

  function countCellResponseFields(fields) {
    var count = 0;
    for (var i = 0; i < fields.length; i += 1) {
      if (isCellResponseField(fields[i].fieldNumber)) {
        count += 1;
      }
    }
    return count;
  }

  function appleWLocPayloadInspect(payload) {
    try {
      var fields = parseFields(payload);
      var parts = [
        "payloadLen=" + payload.length,
        "fields=" + fieldHistogram(fields),
        "wifi=" + countFields(fields, 2),
        "cellResp=" + countCellResponseFields(fields),
        "cellReq=" + countFields(fields, 25),
        "hasCounts=" + (countFields(fields, 3) + "/" + countFields(fields, 4)),
        "deviceType=" + countFields(fields, 33),
        patchedPayloadSummary(payload)
      ];
      return parts.join(", ");
    } catch (err) {
      return "payload parse failed: " + err.message;
    }
  }

  function logRawDump(label, bytes, config) {
    if (!config.dumpRaw || !bytes) {
      return;
    }
    var limit = config.rawLimit || 0;
    var emitted = limit > 0 && bytes.length > limit ? bytes.slice(0, limit) : bytes;
    var encoded = bytesToBase64(emitted);
    var chunkSize = 3000;
    var chunks = Math.max(1, Math.ceil(encoded.length / chunkSize));
    console.log("Location spoofer raw " + label + " base64 begin: len=" + bytes.length + ", emitted=" + emitted.length + ", chunks=" + chunks + ", truncated=" + (emitted.length !== bytes.length));
    for (var i = 0; i < encoded.length; i += chunkSize) {
      var chunkIndex = Math.floor(i / chunkSize) + 1;
      console.log("Location spoofer raw " + label + " base64 chunk " + chunkIndex + "/" + chunks + ": " + encoded.slice(i, i + chunkSize));
    }
    console.log("Location spoofer raw " + label + " base64 end");
  }

  function jsonString(value) {
    try {
      return JSON.stringify(value || {});
    } catch (err) {
      return "<json-failed:" + err.message + ">";
    }
  }

  function logHttpDump(label, message, config) {
    if (!config.dumpHeaders && !config.dumpRaw) {
      return;
    }
    message = message || {};
    var request = typeof $request !== "undefined" ? $request : {};
    var method = message.method || request.method || "<none>";
    var url = message.url || request.url || "<none>";
    var status = message.status || message.statusCode || "<none>";
    console.log("Location spoofer raw " + label + " meta: method=" + method + ", url=" + url + ", status=" + status);
    if (config.dumpHeaders) {
      console.log("Location spoofer raw " + label + " headers: " + jsonString(message.headers || {}));
    }
  }

  function inspectResponseBytes(bytes, config) {
    if (!bytes) {
      console.log("Location spoofer inspect response body unavailable");
      return;
    }
    console.log("Location spoofer inspect response body: len=" + bytes.length + ", head=" + hexPreview(bytes, 48));
    logRawDump("response", bytes, config);
    try {
      var extraction = extractAppleWLocPayload(bytes);
      console.log("Location spoofer inspect response extraction: kind=" + extraction.kind + ", prefix=" + (extraction.prefix ? hexPreview(extraction.prefix, 8) : "<none>") + ", payloadLen=" + extraction.payload.length + ", suffixLen=" + (extraction.suffix ? extraction.suffix.length : 0));
      console.log("Location spoofer inspect response payload: " + appleWLocPayloadInspect(extraction.payload));
    } catch (err) {
      console.log("Location spoofer inspect response extraction failed: " + err.message);
      var directFields = tryParseFields(bytes);
      if (directFields) {
        console.log("Location spoofer inspect response direct fields: " + fieldHistogram(directFields));
      }
    }
  }

  function inspectRequestBytes(bytes, config) {
    if (!bytes) {
      console.log("Location spoofer inspect request body unavailable");
      return;
    }
    console.log("Location spoofer inspect request body: len=" + bytes.length + ", head=" + hexPreview(bytes, 48));
    logRawDump("request", bytes, config);
    try {
      var arpc = parseArpc(bytes);
      console.log("Location spoofer inspect request arpc: version=" + arpc.version + ", functionId=" + arpc.functionId + ", locale=" + arpc.locale + ", app=" + arpc.appIdentifier + ", os=" + arpc.osVersion + ", payloadLen=" + arpc.payload.length);
      console.log("Location spoofer inspect request payload: " + appleWLocPayloadInspect(arpc.payload));
    } catch (err) {
      console.log("Location spoofer inspect request arpc failed: " + err.message);
      var directFields = tryParseFields(bytes);
      if (directFields) {
        console.log("Location spoofer inspect request direct fields: " + fieldHistogram(directFields));
      }
    }
  }

  function doneInspect(config, hasResponse) {
    if (hasResponse) {
      logHttpDump("response", $response, config);
      inspectResponseBytes(messageBodyToBytes($response), config);
    } else {
      logHttpDump("request", $request, config);
      inspectRequestBytes(messageBodyToBytes($request), config);
      if (config.prepareHeaders) {
        donePreparedRequestPassThrough();
        return;
      }
    }
    donePassThrough();
  }

  function doneResponseProbe(config) {
    var response = typeof $response !== "undefined" ? $response : {};
    var headers = response.headers || {};
    if (config.debug) {
      console.log("Location spoofer probe response keys: " + objectKeys(response));
      console.log("Location spoofer probe headers: status=" + (response.status || response.statusCode || "<none>") + ", content-length=" + (headerValue(headers, "Content-Length") || "<none>") + ", content-type=" + (headerValue(headers, "Content-Type") || "<none>") + ", content-encoding=" + (headerValue(headers, "Content-Encoding") || "none"));
      console.log("Location spoofer probe body slots: body=" + valueType(response.body) + "/" + valueLength(response.body) + ", bodyBytes=" + valueType(response.bodyBytes) + "/" + valueLength(response.bodyBytes) + ", rawBody=" + valueType(response.rawBody) + "/" + valueLength(response.rawBody) + ", binaryBody=" + valueType(response.binaryBody) + "/" + valueLength(response.binaryBody));
      var bytes = messageBodyToBytes(response);
      console.log("Location spoofer probe selected body: " + (bytes ? bytes.length : 0) + " bytes, head=" + (bytes ? hexPreview(bytes, 32) : "<none>"));
    }
    donePassThrough();
  }

  function doneSyntheticResponse(bytes, info) {
    var headers = headersWithBinaryBody({}, bytes.length);
    if (info && info.debug) {
      headers["X-Location-Spoofer-Wifi-Count"] = String(info.wifiCount);
      headers["X-Location-Spoofer-Cell-Count"] = String(info.cellCount || 0);
    }
    if (isLoonRuntime()) {
      $done({
        status: 200,
        headers: headers,
        body: bytes
      });
      return;
    }
    $done({
      response: {
        status: 200,
        headers: headers,
        body: bytes
      }
    });
  }

  function doneRewriteResponse(bytes, info) {
    var sourceHeaders = typeof $response !== "undefined" ? $response.headers : {};
    var headers = headersWithBinaryBody(sourceHeaders, bytes.length);
    if (info && info.debug) {
      headers["X-Location-Spoofer-Wifi-Count"] = String(info.wifiCount);
      headers["X-Location-Spoofer-Cell-Count"] = String(info.cellCount || 0);
    }
    if (info && info.targetLat != null && info.targetLng != null) {
      headers["X-Location-Spoofer-Target"] = String(info.targetLat) + "," + String(info.targetLng);
    }
    if (isLoonRuntime()) {
      $done({
        status: ($response && $response.status) || 200,
        headers: headers,
        body: bytes
      });
      return;
    }
    $done({
      headers: headers,
      body: bytes
    });
  }

  function continueResponseRewrite(config) {
    var responseBody = messageBodyToBytes($response);
    if (!responseBody || responseBody.length < 2) {
      if (config.debug) {
        console.log(
          "Location spoofer response body too short: " +
            (responseBody ? responseBody.length : 0) +
            " bytes, head=" +
            (responseBody ? hexPreview(responseBody) : "<none>")
        );
      }
      donePassThrough();
      return;
    }
    if (config.debug) {
      console.log("Location spoofer response body: " + responseBody.length + " bytes, head=" + hexPreview(responseBody, 32));
      if (isLoonRuntime()) {
        console.log("Location spoofer runtime: Loon");
      }
    }
    logHttpDump("response-original", $response, config);
    logRawDump("response-original", responseBody, config);
    var responseResult = spoofAppleResponse(responseBody, config);
    if (config.debug) {
      console.log(
        "Location spoofer patched " +
          responseResult.wifiCount +
          " wifi devices, " +
          responseResult.cellCount +
          " cell towers, kind=" +
          responseResult.kind +
          ", prefix=" +
          (responseResult.prefix || "<none>") +
          ", response=" +
          responseResult.response.length +
          " bytes"
      );
      console.log("Location spoofer patched locations: " + patchedPayloadSummary(responseResult.payload));
    }
    logRawDump("response-patched", responseResult.response, config);
    doneRewriteResponse(responseResult.response, {
      wifiCount: responseResult.wifiCount,
      cellCount: responseResult.cellCount,
      debug: config.debug,
      targetLat: config.latitude,
      targetLng: config.longitude
    });
  }

  function prepareResponseBody(config) {
    prepareResponseBodySync(config);
  }

  function runShadowrocket() {
    var hasRequest = typeof $request !== "undefined" && $request != null;
    var hasResponse = typeof $response !== "undefined" && $response != null;

    if (!hasRequest && !hasResponse) {
      runMaintenanceCron();
      return;
    }

    if (hasRequest && !hasResponse) {
      var prepArgs = readScriptArguments();
      if (parseBoolean(prepArgs.debug, false)) {
        console.log("Location spoofer prepare -> Accept-Encoding: identity");
      }
      donePreparedRequestPassThrough();
      return;
    }

    loadRuntimeConfig(function (config) {
      try {
        if (!config.enabled) {
          donePassThrough();
          return;
        }

        if (config.mode === "inspect") {
          doneInspect(config, hasResponse);
          return;
        }

        if (hasResponse) {
          if (config.debug) {
            console.log(
              "Location spoofer intercept -> lat=" +
                config.latitude +
                ", lng=" +
                config.longitude +
                ", url=" +
                (($request && $request.url) || "<none>")
            );
          }
          if (config.mode === "probe") {
            doneResponseProbe(config);
            return;
          }
          if (config.mode !== "response") {
            donePassThrough();
            return;
          }
          prepareResponseBody(config);
          continueResponseRewrite(config);
          return;
        }

        if (config.mode !== "request") {
          donePassThrough();
          return;
        }
        var requestBody = messageBodyToBytes($request);
        if (config.debug) {
          console.log("Location spoofer request mode body length: " + (requestBody ? requestBody.length : 0));
        }
        if (!requestBody) {
          if (config.debug) {
            console.log("Location spoofer request body unavailable");
          }
          donePassThrough();
          return;
        }
        if (requestBody.length < 2) {
          if (config.debug) {
            console.log("Location spoofer request body too short: " + requestBody.length + " bytes, head=" + hexPreview(requestBody));
          }
          donePassThrough();
          return;
        }
        logHttpDump("request-original", $request, config);
        logRawDump("request-original", requestBody, config);
        var requestResult = spoofArpcRequest(requestBody, config);
        if (config.debug) {
          console.log("Location spoofer request synthetic response: patched " + requestResult.wifiCount + " wifi devices, " + requestResult.cellCount + " cell towers, response=" + requestResult.response.length + " bytes");
          console.log("Location spoofer patched locations: " + patchedPayloadSummary(requestResult.payload));
        }
        logRawDump("request-synthetic-response", requestResult.response, config);
        doneSyntheticResponse(requestResult.response, {
          wifiCount: requestResult.wifiCount,
          cellCount: requestResult.cellCount,
          debug: config.debug
        });
      } catch (err) {
        if (config.debug) {
          var diagBody = hasResponse ? messageBodyToBytes($response) : messageBodyToBytes($request);
          console.log("Location spoofer failed: " + err.message + " | bodyLen=" + (diagBody ? diagBody.length : 0) + " head=" + (diagBody ? hexPreview(diagBody, 32) : "<none>"));
        }
        if (config.failOpen !== false) {
          donePassThrough();
          return;
        }
        $done({
          response: {
            status: "HTTP/1.1 500 Internal Server Error",
            headers: { "Content-Type": "text/plain" },
            body: "location spoofer failed: " + err.message
          }
        });
      }
    });
  }

  var api = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    APPLE_WLOC_PREFIX: APPLE_WLOC_PREFIX,
    APPLE_WLOC_MARKER: APPLE_WLOC_MARKER,
    bodyToBytes: bodyToBytes,
    messageBodyToBytes: messageBodyToBytes,
    hexPreview: hexPreview,
    bytesToBinaryString: bytesToBinaryString,
    bytesToBase64: bytesToBase64,
    binaryStringToBytes: binaryStringToBytes,
    concatBytes: concatBytes,
    readUInt16BE: readUInt16BE,
    writeUInt16BE: writeUInt16BE,
    encodeVarintUnsigned: encodeVarintUnsigned,
    encodeVarintSignedInt64: encodeVarintSignedInt64,
    decodeVarint: decodeVarint,
    makeVarintField: makeVarintField,
    makeLengthDelimitedField: makeLengthDelimitedField,
    parseFields: parseFields,
    tryParseFields: tryParseFields,
    firstFieldByNumber: firstFieldByNumber,
    locationSummary: locationSummary,
    patchedPayloadSummary: patchedPayloadSummary,
    coordToInt: coordToInt,
    normalizeConfig: normalizeConfig,
    patchLocation: patchLocation,
    patchWifiDevice: patchWifiDevice,
    patchCellTower: patchCellTower,
    patchAppleWLocPayload: patchAppleWLocPayload,
    parseArpc: parseArpc,
    serializeArpc: serializeArpc,
    buildAppleWLocResponse: buildAppleWLocResponse,
    extractAppleWLocPayload: extractAppleWLocPayload,
    spoofArpcRequest: spoofArpcRequest,
    spoofAppleResponse: spoofAppleResponse,
    parseArgumentString: parseArgumentString,
    readScriptArguments: readScriptArguments,
    geocodeAddress: geocodeAddress,
    prepareRequestHeaders: prepareRequestHeaders
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    runShadowrocket();
  }
}());
