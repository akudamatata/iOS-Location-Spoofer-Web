/**
 * iOS Location Spoofer Web
 * 
 * Copyright (c) 2026 akudamatata (https://github.com/akudamatata/iOS-Location-Spoofer-Web)
 * Licensed under CC BY-NC-SA 4.0
 * ⚠️【特别声明】：本项目完全免费开源，严禁以任何形式进行二次售卖、转售、商业收费代搭建！
 */

import { DEFAULT_LOC, authOk, jsonResponse, errorResponse, corsHeaders } from './_utils.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!authOk(request, env)) {
    return errorResponse('unauthorized', 401);
  }

  try {
    const data = await request.json();
    let current = DEFAULT_LOC;

    if (env.SPOOFER_DATA) {
      current = await env.SPOOFER_DATA.get('loc', { type: 'json' }) || DEFAULT_LOC;
    }

    const updated = { ...current };
    if (typeof data.latitude           === 'number') updated.latitude           = data.latitude;
    if (typeof data.longitude          === 'number') updated.longitude          = data.longitude;
    if (typeof data.altitude           === 'number') updated.altitude           = data.altitude;
    if (typeof data.horizontalAccuracy === 'number') updated.horizontalAccuracy = data.horizontalAccuracy;
    if (typeof data.verticalAccuracy   === 'number') updated.verticalAccuracy   = data.verticalAccuracy;

    if (env.SPOOFER_DATA) {
      await env.SPOOFER_DATA.put('loc', JSON.stringify(updated));
    }

    return jsonResponse(updated);
  } catch (err) {
    return errorResponse('bad json');
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}
