/**
 * iOS Location Spoofer Web
 * Copyright (c) 2026 akudamatata (https://github.com/akudamatata/iOS-Location-Spoofer-Web)
 * Licensed under CC BY-NC-SA 4.0
 */
import { authOk } from './_utils.js';

export async function onRequestGet({ request, env }) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!authOk(request, env)) {
    return new Response('Unauthorized', { status: 401, headers });
  }

  const script = await env.ASSETS.fetch(new Request(new URL('/location-spoofer.js', request.url)));
  if (!script.ok) {
    return new Response('Script unavailable', { status: 502, headers });
  }

  const token = new URL(request.url).searchParams.get('token');
  const configUrl = new URL('/loc.json', request.url);
  if (token) configUrl.searchParams.set('token', token);

  const config = 'var $locationSpooferConfigUrl = ' + JSON.stringify(configUrl.href) + ';\n';
  headers['Content-Type'] = 'application/javascript; charset=utf-8';
  return new Response(config + await script.text(), { headers });
}
