// Character portraits.
//
// Flat two-tone vector heads, in the same register as the cars: a handful of
// straight-edged shapes, one accent colour each, nothing shaded. They are
// drawn as SVG rather than as images because that is the only way to ship a
// portrait in a project with no asset pipeline — and because at this size a
// hard-edged silhouette reads better across a letterboxed frame than any
// amount of rendering would.
//
// The point of them is attribution. A line of dialogue over a shot of two cars
// belongs to whichever of them is speaking, and a name in small caps does not
// say that nearly as fast as a face does.

// One head, parameterised. Everything that makes two people look like two
// people at ninety pixels is in these six values: the hair, the jaw, whether
// the eyes are covered, and the colour of the collar.
function head({ skin, hair, hairShape, collar, accent, shades, jaw = 0 }) {
  const eyes = shades
    ? `<rect x="26" y="44" width="44" height="11" rx="2" fill="#14171c"/>
       <rect x="28" y="46" width="16" height="4" fill="${accent}" opacity="0.65"/>`
    : `<rect x="30" y="45" width="9" height="6" fill="#14171c"/>
       <rect x="57" y="45" width="9" height="6" fill="#14171c"/>`;
  return `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
    <rect width="96" height="96" fill="#0d1117"/>
    <rect x="0" y="0" width="96" height="96" fill="none" stroke="${accent}" stroke-width="2" opacity="0.5"/>
    <!-- shoulders -->
    <path d="M6 96 L14 74 L38 66 L58 66 L82 74 L90 96 Z" fill="${collar}"/>
    <path d="M40 66 L48 78 L56 66 Z" fill="#0d1117"/>
    <!-- neck and head -->
    <rect x="41" y="58" width="14" height="12" fill="${skin}"/>
    <path d="M28 34 L28 ${58 + jaw} L48 ${70 + jaw} L68 ${58 + jaw} L68 34 Z" fill="${skin}"/>
    ${hairShape(hair)}
    ${eyes}
    <rect x="44" y="56" width="8" height="3" fill="#14171c" opacity="0.55"/>
  </svg>`;
}

const SWEPT = (c) => `<path d="M26 36 L26 22 L70 22 L70 40 L64 30 L40 32 L30 42 Z" fill="${c}"/>`;
const CROPPED = (c) => `<path d="M27 34 L27 21 L69 21 L69 34 L62 28 L34 28 Z" fill="${c}"/>`;
const CAP = (c) => `<path d="M24 34 L24 24 L72 24 L72 34 Z M20 34 L76 34 L76 39 L20 39 Z" fill="${c}"/>`;

// Keyed by the name a script puts in `who`, so a beat needs no extra field.
export const PORTRAITS = {
  YOU: head({
    skin: '#c9926a', hair: '#2c2118', hairShape: SWEPT,
    collar: '#2a3038', accent: '#e8452f', shades: false,
  }),
  KESTREL: head({
    skin: '#a8724c', hair: '#14161a', hairShape: CROPPED,
    collar: '#3a1d1a', accent: '#e8b21f', shades: true, jaw: 2,
  }),
  DISPATCH: head({
    skin: '#b9865e', hair: '#20242a', hairShape: CAP,
    collar: '#1d2b45', accent: '#2a6bff', shades: true,
  }),
};

// The Oakland pack's spokesman. Speaks for the three of them, so the three of
// them do not each need a face for one line apiece.
PORTRAITS.MARLOWE = head({
  skin: '#8a5c3a', hair: '#0f1216', hairShape: CROPPED,
  collar: '#233430', accent: '#35d06a', shades: false, jaw: 3,
});

// Nothing for an unattributed line. Narration — "SIRENS. FOUR BLOCKS OUT." —
// is not somebody speaking, and giving it a face would make it one.
export function portraitFor(who) {
  return PORTRAITS[String(who || '').toUpperCase()] || '';
}
