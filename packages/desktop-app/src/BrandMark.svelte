<script lang="ts">
</script>

<svg class="mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" aria-hidden="true">
  <defs>
    <linearGradient id="outer-gradient" gradientUnits="userSpaceOnUse" x1="76" y1="420" x2="432" y2="128">
      <stop offset="0" stop-color="#2839a7"/>
      <stop offset="0.48" stop-color="#7048ea"/>
      <stop offset="0.72" stop-color="#604fe0"/>
      <stop offset="1" stop-color="#27b7c3"/>
    </linearGradient>
    <linearGradient id="inner-gradient" gradientUnits="userSpaceOnUse" x1="84" y1="415" x2="407" y2="286">
      <stop offset="0" stop-color="#3045b5"/>
      <stop offset="0.43" stop-color="#5260dc"/>
      <stop offset="0.68" stop-color="#12c8d0"/>
      <stop offset="1" stop-color="#0fc5b7"/>
    </linearGradient>
    <linearGradient id="apex-fold" gradientUnits="userSpaceOnUse" x1="241" y1="82" x2="306" y2="151">
      <stop offset="0" stop-color="#7652ef" stop-opacity="0"/>
      <stop offset="0.48" stop-color="#513bc0" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#241b73" stop-opacity="0.82"/>
    </linearGradient>
    <linearGradient id="inner-fold" gradientUnits="userSpaceOnUse" x1="236" y1="281" x2="306" y2="329">
      <stop offset="0" stop-color="#3143ae" stop-opacity="0.92"/>
      <stop offset="0.58" stop-color="#4152cb" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#14c7cb" stop-opacity="0"/>
    </linearGradient>
    <filter id="fold-shadow" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="8" stdDeviation="7" flood-color="#17134f" flood-opacity="0.24"/>
    </filter>
  </defs>
  <path class="ribbon outer-ribbon" d="M 84 406 L 222 112 C 235 83 276 83 290 112 L 428 406" pathLength="1200" stroke="url(#outer-gradient)" stroke-width="78" filter="url(#fold-shadow)"/>
  <path class="fold outer-fold" d="M 256 91 C 272 91 284 100 291 114 L 320 176" fill="none" stroke="url(#apex-fold)" stroke-width="78" stroke-linecap="round" stroke-linejoin="round"/>
  <path class="ribbon inner-ribbon" d="M 84 406 L 166 406 C 181 406 191 398 198 384 L 253 277 C 265 253 297 253 310 277 L 379 406" pathLength="1200" stroke="url(#inner-gradient)" stroke-width="78" filter="url(#fold-shadow)"/>
  <path class="fold inner-fold" d="M 246 291 L 254 276 C 266 253 297 253 310 277 L 329 314" fill="none" stroke="url(#inner-fold)" stroke-width="78" stroke-linecap="round" stroke-linejoin="round"/>
  <path class="finish-sheen" d="M 84 406 L 222 112 C 235 83 276 83 290 112 L 428 406" fill="none" stroke="#ffffff" stroke-opacity=".7" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>

<style>
  .ribbon {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 1200;
    stroke-dashoffset: 1200;
  }
  .outer-ribbon { animation: draw-outer 1.35s cubic-bezier(.65, 0, .25, 1) forwards; }
  .inner-ribbon { animation: draw-inner 1.05s cubic-bezier(.45, 0, .2, 1) .72s forwards; }
  .fold { opacity: 0; animation: reveal-fold .36s ease-out forwards; }
  .outer-fold { animation-delay: .66s; }
  .inner-fold { animation-delay: 1.34s; }
  .finish-sheen {
    opacity: 0;
    transform-origin: 256px 256px;
    animation: finish-sheen .7s ease-out 1.62s forwards;
  }
  @keyframes draw-outer {
    0% { stroke-dashoffset: 1200; opacity: 0; }
    4% { opacity: 1; }
    100% { stroke-dashoffset: 0; opacity: 1; }
  }
  @keyframes draw-inner {
    0% { stroke-dashoffset: 1200; opacity: 0; }
    5% { opacity: 1; }
    100% { stroke-dashoffset: 0; opacity: 1; }
  }
  @keyframes reveal-fold { from { opacity: 0; } to { opacity: 1; } }
  @keyframes finish-sheen {
    0% { opacity: 0; transform: scale(.985); }
    35% { opacity: .24; }
    100% { opacity: 0; transform: scale(1.015); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ribbon { animation: none; stroke-dashoffset: 0; opacity: 1; }
    .fold { animation: none; opacity: 1; }
    .finish-sheen { display: none; }
  }
</style>
