/**
 * iOS Location Spoofer Web
 * 
 * Copyright (c) 2026 akudamatata (https://github.com/akudamatata/iOS-Location-Spoofer-Web)
 * Licensed under CC BY-NC-SA 4.0
 * ⚠️【特别声明】：本项目完全免费开源，严禁以任何形式进行二次售卖、转售、商业收费代搭建！
 */

import { authOk, jsonResponse, errorResponse, corsHeaders } from './_utils.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!authOk(request, env)) {
    return errorResponse('unauthorized', 401);
  }

  return jsonResponse({ ok: true });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}
