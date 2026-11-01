import sharp from 'sharp';
import { normalizeRaster } from '../assets/raster';

/** Original vector sources rasterized locally. Never interpolate user text or decode uploaded SVG. */
function hero(direction: number, frame: number) {
  const north = direction === 3,
    side = direction === 1 || direction === 2;
  const swing = frame < 2 ? 0 : [9, 0, -9, 0][frame - 2];
  const bob = frame === 1 || frame === 3 || frame === 5 ? -1.8 : 0;
  const mirror = direction === 1 ? 'translate(128 0) scale(-1 1)' : '';
  return `<g transform="${mirror}"><g transform="translate(0 ${bob})" stroke="#272735" stroke-width="1.6" stroke-linejoin="round">
    <ellipse cx="64" cy="178" rx="25" ry="6" fill="#0e1928" opacity=".22" stroke="none"/>
    <path d="M45 78 Q29 107 ${35 + swing / 3} 151 Q63 166 90 149 L83 78Z" fill="url(#cloak)"/>
    <path d="M50 130 L${48 + swing} 169 Q${45 + swing} 178 ${52 + swing} 180 L${62 + swing} 179 L${59 + swing} 167 L65 133" fill="#4b3b42"/>
    <path d="M66 130 L${68 - swing} 169 Q${66 - swing} 179 ${72 - swing} 180 L${83 - swing} 177 L${79 - swing} 166 L79 130" fill="#392f3c"/>
    <path d="M${48 + swing} 163 L${59 + swing} 163 L${62 + swing} 179 Q${48 + swing} 183 ${46 + swing} 177Z" fill="#7a4b36"/>
    <path d="M${68 - swing} 163 L${79 - swing} 163 L${83 - swing} 177 Q${72 - swing} 183 ${66 - swing} 178Z" fill="#7a4b36"/>
    <path d="M45 74 Q63 67 81 75 L86 132 Q64 143 42 130Z" fill="url(#coat)"/>
    <path d="M53 76 L64 92 L76 75 L72 125 L57 126Z" fill="#f1ddba"/>
    <path d="M43 78 Q34 85 ${33 - swing / 3} 113 L${39 - swing / 3} 119 L49 91" fill="#226362"/>
    <path d="M82 79 Q91 88 ${91 + swing / 3} 112 L${85 + swing / 3} 120 L76 92" fill="#226362"/>
    <path d="M${33 - swing / 3} 111 Q${27 - swing / 3} 121 ${35 - swing / 3} 124 L${40 - swing / 3} 117" fill="#d7a382"/>
    <path d="M${91 + swing / 3} 111 Q${99 + swing / 3} 120 ${92 + swing / 3} 124 L${85 + swing / 3} 118" fill="#d7a382"/>
    <path d="M43 116 Q64 120 84 115 L84 123 Q64 128 43 123Z" fill="#78513b"/>
    <rect x="59" y="117" width="10" height="9" rx="2" fill="#d5ad60"/>
    <path d="M49 78 L80 120" stroke="#a37e4c" stroke-width="4"/>
    <path d="M76 117 Q91 113 96 122 L94 140 Q84 146 75 138Z" fill="#996644"/>
    <path d="M78 120 Q85 126 95 123" fill="none" stroke="#d7af70"/>
    <circle cx="87" cy="130" r="2" fill="#e7c47c"/>
    <path d="M57 61 L56 76 Q64 83 72 75 L70 60" fill="#c68d71"/>
    <path d="M42 34 Q43 12 65 14 Q90 14 86 41 L81 66 Q64 80 47 65Z" fill="#7e4138"/>
    ${
      !north
        ? `<path d="M46 38 Q64 25 82 38 L79 57 Q75 69 64 70 Q50 67 47 56Z" fill="#e5b694"/>
      <path d="M44 42 Q42 17 63 18 Q87 17 87 40 Q72 38 64 28 Q58 39 44 42Z" fill="url(#hair)"/>
      <path d="M45 39 Q39 56 48 72 L50 51" fill="#ad5c42"/>
      <path d="M82 38 Q92 49 80 69 L78 54" fill="#9e503b"/>
      ${side ? '<path d="M73 44 L79 48 L75 51" fill="#e5b694"/><path d="M69 43 L74 43" stroke="#3c333a"/>' : '<path d="M52 46 Q56 44 59 46 M69 46 Q73 44 77 46" fill="none"/><ellipse cx="56" cy="48" rx="2" ry="2.6" fill="#3a5b5a"/><ellipse cx="73" cy="48" rx="2" ry="2.6" fill="#3a5b5a"/>'}
      <path d="M62 53 L61 57 L65 58 M59 63 Q65 66 70 62" fill="none" stroke="#a16b60" stroke-width="1.1"/>
      <circle cx="48" cy="55" r="2" fill="#e1bc6d"/><circle cx="80" cy="55" r="2" fill="#e1bc6d"/>`
        : '<path d="M43 36 Q45 13 65 15 Q90 13 85 43 L79 67 Q60 78 46 61Z" fill="url(#hair)"/><path d="M59 31 Q56 53 65 70 M69 28 Q74 49 69 64" fill="none" stroke="#e1a46a" opacity=".55"/>'
    }
    <path d="M79 34 Q99 48 91 84 Q99 97 89 103 Q81 91 83 77 Q89 55 78 47" fill="#a85c41"/>
    <path d="M56 76 L63 88 L70 77" fill="none" stroke="#f0c880" stroke-width="2"/>
    <circle cx="64" cy="87" r="3.8" fill="#6fc9b8" stroke="#e4c579"/>
    <path d="M48 128 L46 137 M78 128 L80 136 M47 94 L44 107 M80 94 L83 107" stroke="#d3b571" fill="none"/>
    ${north ? '<path d="M44 78 Q64 70 84 78 L87 134 Q64 151 41 133Z" fill="url(#cloak)"/><path d="M64 87 L69 98 L64 109 L59 98Z" fill="none" stroke="#d3b571" stroke-width="1.8"/>' : ''}
  </g></g>`;
}
const defs = `<defs><linearGradient id="cloak" x2="1" y2="1"><stop stop-color="#314b62"/><stop offset="1" stop-color="#142b42"/></linearGradient><linearGradient id="coat" x2="1" y2="1"><stop stop-color="#397b74"/><stop offset="1" stop-color="#163e47"/></linearGradient><linearGradient id="hair" x2="1" y2="1"><stop stop-color="#d48b54"/><stop offset="1" stop-color="#834336"/></linearGradient></defs>`;
function svg(body: string, width: number, height: number, viewBox = `0 0 ${width} ${height}`) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">${defs}${body}</svg>`;
}
function background(width: number, height: number) {
  let floor = '';
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const tint = ['#b79975', '#aa8b6d', '#c0a17c', '#ad9173'][(x * 11 + y * 7) % 4];
      floor += `<path d="M${x * 96} ${y * 96}h96v96h-96Z" fill="${tint}" stroke="#6e6157" stroke-width="2"/><path d="M${x * 96 + 6} ${y * 96 + 8}h83" stroke="#dcc5a0" opacity=".35"/>`;
    }
  let windows = '';
  for (const x of [2, 5, 10, 13].filter((x) => x < width - 1))
    windows += `<g transform="translate(${x * 96} 20)"><path d="M0 145V50Q46 -5 92 50v95Z" fill="#342e42" stroke="#dab87a" stroke-width="7"/><path d="M10 136V52Q46 8 82 52v84Z" fill="#486275"/><path d="M46 30v106M10 86h72" stroke="#d2b17b" stroke-width="5"/><path d="M19 56L12 81m22 7l-10 35m39-61l-8 27m15 12l-8 24" stroke="#a2c7ce" opacity=".6" stroke-width="2"/></g>`;
  return svg(
    `<defs><radialGradient id="light"><stop stop-color="#ffe1a0" stop-opacity=".22"/><stop offset="1" stop-color="#1e2030" stop-opacity=".25"/></radialGradient></defs>${floor}<rect width="${width * 96}" height="192" fill="#393141"/><path d="M0 174H${width * 96}" stroke="#957653" stroke-width="22"/>${windows}<path d="M0 0v${height * 96}h${width * 96}V0" fill="none" stroke="#292936" stroke-width="105"/><path d="M50 190v${height * 96 - 246}h${width * 96 - 100}V190" fill="none" stroke="#8b7059" stroke-width="10"/><rect x="45" y="45" width="${width * 96 - 90}" height="${height * 96 - 90}" fill="url(#light)"/>`,
    width * 96,
    height * 96,
  );
}
function prop(role: string) {
  let body = '';
  if (role === 'rug')
    body =
      '<path d="M25 95L335 78L365 332L38 351Z" fill="#784e66" stroke="#d3ad76" stroke-width="9"/><path d="M50 113L313 100L336 310L62 327Z" fill="none" stroke="#c49e72" stroke-width="3"/><path d="M191 130l58 82-58 83-58-83Z" fill="#374b60" stroke="#c49e72" stroke-width="5"/>';
  if (role === 'table' || role === 'counter')
    body = `<ellipse cx="195" cy="338" rx="177" ry="33" fill="#18202a" opacity=".3"/><path d="M46 215L37 337h32l18-114M305 214l18 122h32l-11-130" fill="#4f3c3d"/><path d="M24 151L344 132L371 264L39 286Z" fill="#68483a" stroke="#342f38" stroke-width="6"/><path d="M24 141L344 122L371 241L39 263Z" fill="#af8055" stroke="#e3b476" stroke-width="5"/><path d="M43 174l304-18M54 220l302-18" stroke="#614536" opacity=".6" stroke-width="3"/><path d="M90 134L154 127L164 192L99 200Z" fill="#434d66" stroke="#dfc492" stroke-width="3"/><path d="M101 145l42-5m-39 17l42-5m-38 17l35-4" stroke="#b6b6ae" stroke-width="2"/><ellipse cx="244" cy="201" rx="51" ry="17" fill="#523c49"/><path d="M225 131v28q-27 31-16 43q37 20 67-3q9-17-25-41v-29" fill="#7fb7a6" stroke="#daecd4" stroke-width="3"/><path d="M216 180q27-9 47 0v17q-23 13-45 0Z" fill="#6de0bb" opacity=".65"/><path d="M221 130h35" stroke="#ddb680" stroke-width="8"/><circle cx="287" cy="157" r="16" fill="#e5b06a" stroke="#6b4941" stroke-width="4"/>`;
  if (role === 'counter')
    body =
      body.replaceAll('#af8055', '#8d5550').replaceAll('#68483a', '#493446') +
      '<path d="M44 267L367 245L359 341L52 359Z" fill="#653e47" stroke="#c09664" stroke-width="5"/><path d="M78 278L333 261L328 319L85 339Z" fill="none" stroke="#a47759" stroke-width="3"/><path d="M196 270v66" stroke="#a47759" stroke-width="4"/>';
  if (role === 'shelf') {
    body =
      '<ellipse cx="190" cy="354" rx="170" ry="21" fill="#1a1f2b" opacity=".3"/><path d="M30 48L350 31v315L30 363Z" fill="#4b3c43" stroke="#c09460" stroke-width="8"/>';
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 10; i++)
        body += `<path d="M${48 + i * 29} ${63 + row * 91}h20v69h-20Z" fill="${['#c18a62', '#607c78', '#a25862', '#b7a46c', '#52647e'][i % 5]}" stroke="#302e3b" stroke-width="2"/><path d="M${53 + i * 29} ${72 + row * 91}v50" stroke="#e4c693" opacity=".6"/>`;
      body += `<path d="M30 ${144 + row * 91}L350 ${128 + row * 91}" stroke="#ac7d52" stroke-width="11"/>`;
    }
  }
  if (role === 'plant')
    body =
      '<ellipse cx="193" cy="352" rx="100" ry="24" fill="#1b2430" opacity=".25"/><path d="M120 251h143l-21 98q-55 24-101 0Z" fill="#a26951" stroke="#553f40" stroke-width="5"/><ellipse cx="192" cy="252" rx="75" ry="21" fill="#473e3f"/><path d="M192 263V70m0 163Q72 177 64 113q105 3 128 120m0-35Q295 133 310 71q-113 3-118 127m0-37Q123 84 150 29q62 35 42 132m0 86Q280 252 317 192q-82-28-125 55" fill="#416f5e" stroke="#9cb17b" stroke-width="5"/>';
  if (role === 'door-closed' || role === 'door-open')
    body = `<ellipse cx="196" cy="352" rx="142" ry="20" fill="#131e2c" opacity=".3"/><path d="M81 345V91Q191-21 304 91v254" fill="#423642" stroke="#d4ad70" stroke-width="13"/>${role === 'door-open' ? '<path d="M99 343V98Q191 6 286 98v245Z" fill="#1d3444"/><path d="M99 98L177 69v276l-78-2Z" fill="#91684a" stroke="#e4c58a" stroke-width="5"/>' : '<path d="M100 338V99Q191 9 285 99v239Z" fill="#705149" stroke="#be976b" stroke-width="4"/><path d="M121 194V111Q191 41 265 111v83Z" fill="#537487" stroke="#e5bd7d" stroke-width="5"/><path d="M192 68v127m-68-53h139" stroke="#b99b6d" stroke-width="5"/><path d="M123 223h137v92H123Z" fill="#614847" stroke="#bf9365" stroke-width="3"/><circle cx="252" cy="217" r="8" fill="#e4c17c"/>'}`;
  return svg(`<g stroke-linejoin="round">${body}</g>`, 384, 384);
}
export async function fixtureRaster(role: string) {
  let source =
    role === 'concept'
      ? svg(hero(0, 0), 384, 576, '0 0 128 192')
      : role === 'portrait'
        ? svg(hero(0, 0), 384, 384, '30 8 69 80')
        : role === 'sheet' || role === 'npc-sheet'
          ? svg(
              Array.from(
                { length: 24 },
                (_, i) =>
                  `<g transform="translate(${(i % 6) * 128} ${Math.floor(i / 6) * 192})">${hero(Math.floor(i / 6), i % 6)}</g>`,
              ).join(''),
              768,
              768,
            )
          : role === 'background'
            ? background(16, 12)
            : role === 'annex-background'
              ? background(8, 7)
              : prop(role);
  if (role === 'npc-sheet')
    source = source
      .replaceAll('#397b74', '#ad7559')
      .replaceAll('#163e47', '#683f45')
      .replaceAll('#d48b54', '#594c62')
      .replaceAll('#834336', '#312d42');
  const bytes = await sharp(Buffer.from(source)).png().toBuffer();
  return normalizeRaster(bytes, 'image/png', !role.endsWith('background'));
}
