/**
 * iOS Location Spoofer Web
 * 
 * Copyright (c) 2026 akudamatata (https://github.com/akudamatata/iOS-Location-Spoofer-Web)
 * Licensed under CC BY-NC-SA 4.0
 * ⚠️【特别声明】：本项目完全免费开源，严禁以任何形式进行二次售卖、转售、商业收费代搭建！
 */

export async function onRequestGet(context) {
  const { request, env } = context;

  // Fetch the static index.html from Cloudflare Pages ASSETS
  const response = await env.ASSETS.fetch(request);
  
  if (!response.ok) {
    return response;
  }

  const token = env.TOKEN || '';
  const amapKey = env.AMAP_KEY || '';

  const configScript = `<script>window.__CFG__=${JSON.stringify({ token, amapKey })};</script>`;

  // Use HTMLRewriter to inject the config script just before the closing </head> tag
  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append(configScript, { html: true });
      }
    })
    .transform(response);
}
