// Shared big-character renderer for the canvas mini-games (Library Shift,
// Kitchen Shift) — extracted from library-game.js so both games draw people
// the same way: a wide rounded torso the head sits directly on, short arms
// with hands, short legs with shoes, a ground shadow, and a face/hair/outfit
// driven entirely by a plain "personality" object rather than per-game code.
// Canvas primitives only, no image assets (this site has none).
//
// Personality shape: { bodyColor, pantsColor?, headColor, hairColor?,
//   accentColor?, eyeColor, eyeShape: 'narrow'|'roundSmall'|'bigRound',
//   browAngle (− angry, + cheerful), mouthCurve (− frown, + smile),
//   blush, hairStyle, outfit, glasses?, accessory?, hatColor?, shoeColor? }

/**
 * Generic people designs shared by the mini-games — originally Library
 * Shift's patron templates (v2.12), now also Kitchen Shift's customers.
 * Each supplies its own face (brow angle, mouth curve, eye shape) and
 * silhouette (hair, outfit, accessory), not just a palette.
 */
export const PEOPLE_TEMPLATES = {
  grumpyRegular: {
    label: 'Grumpy Regular',
    bodyColor: '#7d8570', pantsColor: '#5a5f4f', headColor: '#c68642', hairColor: '#5a5248',
    eyeColor: '#3a2a2a', eyeShape: 'narrow', browAngle: -0.8, mouthCurve: -1.4, blush: false,
    hairStyle: 'receding', outfit: 'cardigan', glasses: true, shoeColor: '#4a3a32',
  },
  shyStudent: {
    label: 'Shy Student',
    bodyColor: '#a7c4d1', pantsColor: '#5c7480', headColor: '#ffdbac', hairColor: '#3a2a20',
    eyeColor: '#2a2a3a', eyeShape: 'roundSmall', browAngle: 0.15, mouthCurve: 0.3, blush: true,
    hairStyle: 'bangs', outfit: 'collar', glasses: false, shoeColor: '#3a3440',
  },
  cheerfulKid: {
    label: 'Cheerful Kid',
    bodyColor: '#f2b6c6', pantsColor: '#e0899f', headColor: '#8d5524', hairColor: '#2a1a10',
    eyeColor: '#2a2a2a', eyeShape: 'bigRound', browAngle: 0.7, mouthCurve: 1.6, blush: true,
    hairStyle: 'pigtails', outfit: 'overalls', glasses: false, shoeColor: '#c65f7c',
  },
  teen: {
    label: 'Teen',
    bodyColor: '#6a7bd0', pantsColor: '#3a3f5a', headColor: '#f1c27d', hairColor: '#1e1e28', accentColor: '#4f5db0',
    eyeColor: '#2a2a3a', eyeShape: 'narrow', browAngle: 0, mouthCurve: 0.2, blush: false,
    hairStyle: 'spiky', outfit: 'hoodie', accessory: 'headphones', shoeColor: '#e8e8e8',
  },
  grandma: {
    label: 'Grandma',
    bodyColor: '#b48ab8', pantsColor: '#6a5a70', headColor: '#f5d6c0', hairColor: '#e6e2dc', accentColor: '#e8b95a',
    eyeColor: '#3a2a2a', eyeShape: 'roundSmall', browAngle: 0.4, mouthCurve: 1.2, blush: true,
    hairStyle: 'bun', outfit: 'shawl', glasses: true, shoeColor: '#6a4a3a',
  },
  businessman: {
    label: 'Businessman',
    bodyColor: '#3f4a5c', pantsColor: '#2e3644', headColor: '#a8754a', hairColor: '#2a2018', accentColor: '#c0392b',
    eyeColor: '#2a2a2a', eyeShape: 'narrow', browAngle: -0.3, mouthCurve: -0.3, blush: false,
    hairStyle: 'sidePart', outfit: 'suitTie', shoeColor: '#1e1e1e',
  },
  artist: {
    label: 'Artist',
    bodyColor: '#e3a45a', pantsColor: '#e3a45a', headColor: '#ffdbac', hairColor: '#c0603a', accentColor: '#2f4858',
    eyeColor: '#2a3a2a', eyeShape: 'bigRound', browAngle: 0.5, mouthCurve: 0.9, blush: true,
    hairStyle: 'long', outfit: 'dress', accessory: 'beret', shoeColor: '#2f4858',
  },
  bearded: {
    label: 'Bearded Guy',
    bodyColor: '#b0453a', pantsColor: '#4a5a6a', headColor: '#e0ac69', hairColor: '#6a4a2a', accentColor: '#3a2a2a',
    eyeColor: '#2a2a2a', eyeShape: 'roundSmall', browAngle: -0.2, mouthCurve: 0.6, blush: false,
    hairStyle: 'beanie', outfit: 'flannel', accessory: 'beard', hatColor: '#3f7a6a', shoeColor: '#5a3a22',
  },
  curly: {
    label: 'Curly',
    bodyColor: '#fdf8ee', pantsColor: '#5a7aa0', headColor: '#6b4226', hairColor: '#1a120c', accentColor: '#e06a5b',
    eyeColor: '#1a1a1a', eyeShape: 'bigRound', browAngle: 0.4, mouthCurve: 1.4, blush: false,
    hairStyle: 'curly', outfit: 'stripes', shoeColor: '#e06a5b',
  },
  karen: {
    label: 'Karen',
    bodyColor: '#d94f4f', pantsColor: '#8f2f2f', headColor: '#e0ac69', hairColor: '#d6b23e',
    eyeColor: '#3a2a2a', eyeShape: 'narrow', browAngle: -1.3, mouthCurve: -0.6, blush: false,
    hairStyle: 'bob', outfit: 'blazer', glasses: false, shoeColor: '#2a2020',
  },
};

function drawRoundRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function drawLibraryFace(ctx, x, y, s, personality, angryTint) {
  const headCenterY = y - 34 * s;
  const eyeY = headCenterY + 1 * s;

  for (const dir of [-1, 1]) {
    const ex = x + dir * 3.7 * s;
    let rx = 1.9 * s;
    let ry = 2.6 * s;
    if (personality.eyeShape === 'bigRound') { rx = 2.4 * s; ry = 3 * s; }
    else if (personality.eyeShape === 'narrow') { rx = 2.1 * s; ry = 1.3 * s; }
    else if (personality.eyeShape === 'roundSmall') { rx = 1.4 * s; ry = 1.8 * s; }

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = personality.eyeColor;
    ctx.beginPath();
    ctx.arc(ex, eyeY + 0.3 * s, Math.min(rx, ry) * 0.62, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ex - 0.5 * s, eyeY - 0.5 * s, 0.5 * s, 0, Math.PI * 2);
    ctx.fill();

    // Eyebrow — angle mirrors between the two eyes (a V-shape frown reads
    // as angled DOWN toward the nose on both sides, not literally parallel
    // tilted lines), so `dir` flips the sign for the outer-vs-inner end.
    ctx.strokeStyle = personality.eyeColor;
    ctx.lineWidth = Math.max(1, 0.7 * s);
    const tilt = personality.browAngle * dir * 2.4 * s;
    ctx.beginPath();
    ctx.moveTo(ex - dir * 1.8 * s, eyeY - 3.6 * s - tilt);
    ctx.lineTo(ex + dir * 1.8 * s, eyeY - 3.6 * s + tilt);
    ctx.stroke();
  }

  if (personality.blush) {
    ctx.fillStyle = 'rgba(247,155,175,0.55)';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + dir * 5.8 * s, headCenterY + 3.2 * s, 1.6 * s, 1 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Mouth: curve sign/magnitude from personality.mouthCurve — a small arc
  // whose bow direction and depth vary, rather than one fixed smile shape.
  ctx.strokeStyle = '#8a4a4a';
  ctx.lineWidth = Math.max(1, 0.8 * s);
  const mouthY = headCenterY + 5 * s;
  const curve = personality.mouthCurve;
  ctx.beginPath();
  if (Math.abs(curve) < 0.5) {
    // Near-flat/tight mouth (Karen, a wary neutral) — a short straight line.
    ctx.moveTo(x - 1.6 * s, mouthY);
    ctx.lineTo(x + 1.6 * s, mouthY);
  } else if (curve > 0) {
    ctx.arc(x, mouthY - 1.2 * s * Math.min(curve, 1.6), 1.6 * s * Math.min(1 + curve * 0.3, 2.2), 0.15 * Math.PI, 0.85 * Math.PI);
  } else {
    ctx.arc(x, mouthY + 2.4 * s, 1.8 * s, 1.15 * Math.PI, 1.85 * Math.PI);
  }
  ctx.stroke();

  if (angryTint) {
    ctx.fillStyle = 'rgba(214,60,60,0.32)';
    ctx.beginPath();
    ctx.arc(x, headCenterY, 10 * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Mixes a `#rrggbb` color toward black (negative `amount`) or white
 * (positive), for cheap one-step shading of the flat-color primitives
 * below without hand-picking a second hex per palette entry.
 */
export function shadeColor(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  const mix = (c) => Math.round(c + (target - c) * t);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Hair that sits *behind* the head circle (drawn before it): bob volume, pigtails. */
function drawBackHair(ctx, x, headY, s, personality) {
  const color = personality.hairColor;
  if (personality.hairStyle === 'long') {
    drawRoundRect(ctx, x - 12 * s, headY - 6 * s, 24 * s, 22 * s, 6 * s, color);
  } else if (personality.hairStyle === 'curly') {
    ctx.fillStyle = color;
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI * (0.95 + i * 0.1375);
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * 10.5 * s, headY - 1 * s + Math.sin(a) * 10.5 * s, 4.6 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + dir * 11 * s, headY + 3 * s, 4 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (personality.hairStyle === 'bun') {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, headY - 12.5 * s, 4.8 * s, 0, Math.PI * 2);
    ctx.fill();
  } else if (personality.hairStyle === 'bob') {
    drawRoundRect(ctx, x - 12.5 * s, headY - 6 * s, 25 * s, 15 * s, 5 * s, color);
  } else if (personality.hairStyle === 'pigtails') {
    ctx.fillStyle = color;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + dir * 12 * s, headY - 1 * s, 4.2 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#f2d98a';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + dir * 9.6 * s, headY - 3 * s, 1.6 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Hair that sits *over* the head circle (drawn after it, before the face). */
function drawFrontHair(ctx, x, headY, s, personality) {
  const color = personality.hairColor;
  ctx.fillStyle = color;
  if (personality.hairStyle === 'receding') {
    // Thinning on top: side tufts above the ears plus a thin crown band.
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + dir * 8.6 * s, headY - 3 * s, 2.6 * s, 4.2 * s, dir * 0.25, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, headY - 1.5 * s, 10.3 * s, Math.PI * 1.08, Math.PI * 1.92);
    ctx.arc(x, headY + 1 * s, 10.3 * s, Math.PI * 1.85, Math.PI * 1.15, true);
    ctx.fill();
    return;
  }

  if (personality.hairStyle === 'beanie') {
    // Tufts of hair under a knit beanie with a fold-up band and a pompom.
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + dir * 8.8 * s, headY - 0.5 * s, 2.4 * s, 3.4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const hat = personality.hatColor || '#3f7a6a';
    ctx.fillStyle = hat;
    ctx.beginPath();
    ctx.arc(x, headY - 3 * s, 11 * s, Math.PI, 0);
    ctx.fill();
    drawRoundRect(ctx, x - 11.5 * s, headY - 4.5 * s, 23 * s, 4 * s, 1.5 * s, shadeColor(hat, -0.2));
    ctx.fillStyle = shadeColor(hat, 0.35);
    ctx.beginPath();
    ctx.arc(x, headY - 14.5 * s, 2.8 * s, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Every other style starts from a full cap over the top of the head.
  ctx.beginPath();
  ctx.arc(x, headY - 2.5 * s, 10.6 * s, Math.PI, 0);
  ctx.fill();

  if (personality.hairStyle === 'bangs') {
    // A soft fringe of three scallops across the forehead, plus side locks.
    for (const dx of [-5.5, 0, 5.5]) {
      ctx.beginPath();
      ctx.ellipse(x + dx * s, headY - 3.6 * s, 3.6 * s, 2.4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const dir of [-1, 1]) {
      drawRoundRect(ctx, x + (dir < 0 ? -10.6 : 7.6) * s, headY - 3 * s, 3 * s, 8 * s, 1.5 * s, color);
    }
  } else if (personality.hairStyle === 'bob') {
    // The asymmetric swoop: a heavy side-part sweeping down over one brow.
    ctx.beginPath();
    ctx.moveTo(x - 10.6 * s, headY - 2.5 * s);
    ctx.quadraticCurveTo(x - 2 * s, headY - 6 * s, x + 9 * s, headY - 1 * s);
    ctx.lineTo(x + 10.6 * s, headY - 2.5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = shadeColor(color, -0.25);
    ctx.lineWidth = Math.max(1, 0.6 * s);
    ctx.beginPath();
    ctx.moveTo(x - 3 * s, headY - 12 * s);
    ctx.quadraticCurveTo(x - 1 * s, headY - 7 * s, x + 6 * s, headY - 4 * s);
    ctx.stroke();
  } else if (personality.hairStyle === 'spiky') {
    for (let i = 0; i < 5; i++) {
      const bx = x + (i - 2) * 4.4 * s;
      ctx.beginPath();
      ctx.moveTo(bx - 3 * s, headY - 9 * s);
      ctx.lineTo(bx + (i - 2) * 0.8 * s, headY - 16 * s);
      ctx.lineTo(bx + 3 * s, headY - 9 * s);
      ctx.closePath();
      ctx.fill();
    }
  } else if (personality.hairStyle === 'sidePart') {
    ctx.beginPath();
    ctx.moveTo(x - 10.6 * s, headY - 2.5 * s);
    ctx.quadraticCurveTo(x - 4 * s, headY - 7 * s, x + 6 * s, headY - 4 * s);
    ctx.lineTo(x + 10.6 * s, headY - 2.5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = shadeColor(personality.headColor, -0.15);
    ctx.lineWidth = Math.max(1, 0.6 * s);
    ctx.beginPath();
    ctx.moveTo(x - 4 * s, headY - 12.5 * s);
    ctx.lineTo(x - 3 * s, headY - 6.5 * s);
    ctx.stroke();
  } else if (personality.hairStyle === 'long') {
    for (const dx of [-5, 0, 5]) {
      ctx.beginPath();
      ctx.ellipse(x + dx * s, headY - 4 * s, 4 * s, 2.4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (personality.hairStyle === 'curly') {
    for (const dx of [-6, -2, 2, 6]) {
      ctx.beginPath();
      ctx.arc(x + dx * s, headY - 6 * s, 3.2 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (personality.hairStyle === 'bun') {
    // Hair pulled back: a tidy cap with a center part.
    ctx.strokeStyle = shadeColor(color, -0.25);
    ctx.lineWidth = Math.max(1, 0.6 * s);
    ctx.beginPath();
    ctx.moveTo(x, headY - 12.5 * s);
    ctx.lineTo(x, headY - 6 * s);
    ctx.stroke();
  } else if (personality.hairStyle === 'pigtails') {
    // A short center part.
    ctx.strokeStyle = shadeColor(personality.headColor, -0.1);
    ctx.lineWidth = Math.max(1, 0.6 * s);
    ctx.beginPath();
    ctx.moveTo(x, headY - 12.5 * s);
    ctx.lineTo(x, headY - 8 * s);
    ctx.stroke();
  }
}

/** Torso-level clothing detail, drawn on top of the plain shirt shape. */
function drawOutfitDetail(ctx, x, y, s, personality) {
  const torsoTop = y - 26 * s;
  if (personality.outfit === 'cardigan') {
    // Open cardigan over a lighter shirt: a center V of shirt plus buttons.
    ctx.fillStyle = '#efe6d2';
    ctx.beginPath();
    ctx.moveTo(x - 4 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 4 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 1.5 * s, y - 5 * s);
    ctx.lineTo(x - 1.5 * s, y - 5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = shadeColor(personality.bodyColor, -0.35);
    for (const dy of [-18, -13, -8]) {
      ctx.beginPath();
      ctx.arc(x + 3.4 * s, y + dy * s, 0.9 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (personality.outfit === 'collar') {
    // A white collar and a backpack strap across one shoulder.
    ctx.fillStyle = '#fdf8ee';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x, torsoTop + 4 * s);
      ctx.lineTo(x + dir * 5 * s, torsoTop + 1 * s);
      ctx.lineTo(x + dir * 4 * s, torsoTop + 5.5 * s);
      ctx.closePath();
      ctx.fill();
    }
    drawRoundRect(ctx, x + 5 * s, torsoTop + 1 * s, 2.6 * s, 19 * s, 1.2 * s, '#c47f4e');
  } else if (personality.outfit === 'overalls') {
    // Overall bib + straps in the pants color, with two gold buttons.
    const bib = personality.pantsColor;
    drawRoundRect(ctx, x - 6 * s, y - 16 * s, 12 * s, 12 * s, 2.5 * s, bib);
    for (const dir of [-1, 1]) {
      drawRoundRect(ctx, x + (dir < 0 ? -7 : 4.6) * s, torsoTop + 1 * s, 2.4 * s, 11 * s, 1 * s, bib);
    }
    ctx.fillStyle = '#f2d98a';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + dir * 4.4 * s, y - 14 * s, 1 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    drawRoundRect(ctx, x - 2.5 * s, y - 12 * s, 5 * s, 3.5 * s, 1 * s, shadeColor(bib, -0.15));
  } else if (personality.outfit === 'vestLanyard') {
    // Sweater vest over a cream shirt, plus a lanyard with a name badge.
    const vest = personality.accentColor;
    ctx.fillStyle = vest;
    ctx.beginPath();
    ctx.moveTo(x - 10 * s, torsoTop + 2 * s);
    ctx.lineTo(x - 3.5 * s, torsoTop + 2 * s);
    ctx.lineTo(x, torsoTop + 9 * s);
    ctx.lineTo(x + 3.5 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 10 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 10 * s, y - 6 * s);
    ctx.lineTo(x - 10 * s, y - 6 * s);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#c0392b';
    ctx.lineWidth = Math.max(1, 0.7 * s);
    ctx.beginPath();
    ctx.moveTo(x - 3.5 * s, torsoTop + 1 * s);
    ctx.lineTo(x - 1 * s, y - 14 * s);
    ctx.moveTo(x + 3.5 * s, torsoTop + 1 * s);
    ctx.lineTo(x + 1 * s, y - 14 * s);
    ctx.stroke();
    drawRoundRect(ctx, x - 3 * s, y - 14.5 * s, 6 * s, 7 * s, 1 * s, '#fdf8ee');
    ctx.fillStyle = '#5b6cc0';
    ctx.fillRect(x - 2 * s, y - 13.5 * s, 4 * s, 1.4 * s);
  } else if (personality.outfit === 'hoodie') {
    // Hood bunched behind the neck, kangaroo pocket, drawstrings.
    const dark = personality.accentColor;
    drawRoundRect(ctx, x - 8 * s, torsoTop - 1 * s, 16 * s, 5 * s, 2.5 * s, dark);
    drawRoundRect(ctx, x - 6.5 * s, y - 13 * s, 13 * s, 6 * s, 2 * s, dark);
    ctx.strokeStyle = '#fdf8ee';
    ctx.lineWidth = Math.max(1, 0.6 * s);
    for (const dx of [-2, 2]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * s, torsoTop + 3 * s);
      ctx.lineTo(x + dx * s, torsoTop + 9 * s);
      ctx.stroke();
    }
  } else if (personality.outfit === 'shawl') {
    // A knitted shawl draped over the shoulders, pinned with a brooch.
    ctx.fillStyle = personality.accentColor;
    ctx.beginPath();
    ctx.moveTo(x - 12 * s, torsoTop + 1 * s);
    ctx.lineTo(x + 12 * s, torsoTop + 1 * s);
    ctx.lineTo(x, y - 9 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#c0392b';
    ctx.beginPath();
    ctx.arc(x, torsoTop + 5 * s, 1.5 * s, 0, Math.PI * 2);
    ctx.fill();
  } else if (personality.outfit === 'suitTie') {
    // Suit jacket with a white shirt V and a tie.
    ctx.fillStyle = '#fdf8ee';
    ctx.beginPath();
    ctx.moveTo(x - 4 * s, torsoTop + 1 * s);
    ctx.lineTo(x + 4 * s, torsoTop + 1 * s);
    ctx.lineTo(x, y - 9 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = personality.accentColor;
    ctx.beginPath();
    ctx.moveTo(x - 1.4 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 1.4 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 1.8 * s, y - 11 * s);
    ctx.lineTo(x, y - 9 * s);
    ctx.lineTo(x - 1.8 * s, y - 11 * s);
    ctx.closePath();
    ctx.fill();
  } else if (personality.outfit === 'dress') {
    // A flared skirt over the upper legs, with a little collar.
    ctx.fillStyle = shadeColor(personality.bodyColor, -0.08);
    ctx.beginPath();
    ctx.moveTo(x - 10 * s, y - 7 * s);
    ctx.lineTo(x + 10 * s, y - 7 * s);
    ctx.lineTo(x + 13 * s, y + 1 * s);
    ctx.lineTo(x - 13 * s, y + 1 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fdf8ee';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + dir * 2.5 * s, torsoTop + 2 * s, 2.5 * s, 0, Math.PI);
      ctx.fill();
    }
  } else if (personality.outfit === 'stripes') {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x - 11 * s, torsoTop, 22 * s, 21 * s, 6 * s);
    ctx.clip();
    ctx.fillStyle = personality.accentColor;
    for (let i = 0; i < 5; i++) ctx.fillRect(x - 11 * s, torsoTop + 3 * s + i * 4 * s, 22 * s, 1.8 * s);
    ctx.restore();
  } else if (personality.outfit === 'flannel') {
    // Plaid: darker vertical and horizontal bands.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x - 11 * s, torsoTop, 22 * s, 21 * s, 6 * s);
    ctx.clip();
    ctx.fillStyle = 'rgba(40,20,20,0.28)';
    for (let i = -2; i <= 2; i++) ctx.fillRect(x + i * 5 * s - 0.9 * s, torsoTop, 1.8 * s, 21 * s);
    for (let j = 0; j < 4; j++) ctx.fillRect(x - 11 * s, torsoTop + 3 * s + j * 5 * s, 22 * s, 1.8 * s);
    ctx.restore();
    ctx.fillStyle = '#fdf8ee';
    for (const dy of [-18, -13, -8]) {
      ctx.beginPath();
      ctx.arc(x, y + dy * s, 0.8 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (personality.outfit === 'blazer') {
    // Sharp lapels over a white blouse, plus a pearl necklace.
    ctx.fillStyle = '#fdf8ee';
    ctx.beginPath();
    ctx.moveTo(x - 4.5 * s, torsoTop + 1 * s);
    ctx.lineTo(x + 4.5 * s, torsoTop + 1 * s);
    ctx.lineTo(x, y - 10 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = shadeColor(personality.bodyColor, -0.25);
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + dir * 4.5 * s, torsoTop + 1 * s);
      ctx.lineTo(x + dir * 1 * s, y - 11 * s);
      ctx.lineTo(x + dir * 7 * s, torsoTop + 6 * s);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#fdf8ee';
    for (const dx of [-3, -1.5, 0, 1.5, 3]) {
      ctx.beginPath();
      ctx.arc(x + dx * s, torsoTop + 3 * s + Math.abs(dx) * -0.5 * s + 1.5 * s, 0.8 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (personality.outfit === 'apron') {
    // Kitchen Shift's food-server/cook look: a bib apron (accentColor) with
    // neck straps, a front pocket, and a little waist tie.
    const apron = personality.accentColor || '#fdf8ee';
    for (const dir of [-1, 1]) {
      drawRoundRect(ctx, x + (dir < 0 ? -6.5 : 4.5) * s, torsoTop + 0.5 * s, 2 * s, 7 * s, 1 * s, apron);
    }
    drawRoundRect(ctx, x - 7 * s, torsoTop + 6 * s, 14 * s, 16 * s, 3 * s, apron);
    drawRoundRect(ctx, x - 4 * s, y - 14 * s, 8 * s, 4.5 * s, 1.5 * s, shadeColor(apron, -0.1));
    ctx.fillStyle = shadeColor(apron, -0.2);
    ctx.fillRect(x - 11 * s, y - 15.5 * s, 22 * s, 1.6 * s);
  } else if (personality.outfit === 'uniform') {
    // A guard's uniform: shirt pocket flaps, a gold badge, a dark belt.
    ctx.fillStyle = shadeColor(personality.bodyColor, -0.2);
    for (const dir of [-1, 1]) {
      ctx.fillRect(x + (dir < 0 ? -8 : 3) * s, torsoTop + 5 * s, 5 * s, 1.4 * s);
    }
    ctx.fillStyle = personality.accentColor || '#e0c25a';
    ctx.beginPath();
    ctx.arc(x - 5.5 * s, torsoTop + 9 * s, 1.8 * s, 0, Math.PI * 2);
    ctx.fill();
    drawRoundRect(ctx, x - 11 * s, y - 8 * s, 22 * s, 2.4 * s, 1 * s, '#1e1e24');
  }
}

function drawGlasses(ctx, x, headY, s) {
  const eyeY = headY + 1 * s;
  ctx.strokeStyle = '#3a2a2a';
  ctx.lineWidth = Math.max(1, 0.7 * s);
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + dir * 3.9 * s, eyeY, 3.1 * s, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(x - 0.8 * s, eyeY - 0.5 * s);
  ctx.lineTo(x + 0.8 * s, eyeY - 0.5 * s);
  ctx.stroke();
}

/** Eye bags and a sweat drop for a stressed (low-Sanity) face. */
function drawStressMarks(ctx, x, headY, s, stress) {
  ctx.strokeStyle = `rgba(90,60,110,${0.25 + 0.45 * stress})`;
  ctx.lineWidth = Math.max(1, 0.8 * s);
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + dir * 3.7 * s, headY + 2.6 * s, 2 * s, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }
  // Sweat drop at the temple.
  ctx.fillStyle = 'rgba(140,200,240,0.9)';
  ctx.beginPath();
  const dx = x + 8.5 * s;
  const dy = headY - 3 * s;
  ctx.moveTo(dx, dy - 3 * s);
  ctx.quadraticCurveTo(dx + 2.4 * s, dy + 0.5 * s, dx, dy + 1.8 * s);
  ctx.quadraticCurveTo(dx - 2.4 * s, dy + 0.5 * s, dx, dy - 3 * s);
  ctx.fill();
  if (stress > 0.85) {
    // Frazzled: a couple of stray hairs sticking up.
    ctx.strokeStyle = 'rgba(58,42,42,0.7)';
    ctx.lineWidth = Math.max(1, 0.7 * s);
    for (const [ox, oy] of [[-3, -12], [2, -13], [6, -11]]) {
      ctx.beginPath();
      ctx.moveTo(x + ox * s, headY + oy * s);
      ctx.lineTo(x + (ox + 1.5) * s, headY + (oy - 3.5) * s);
      ctx.stroke();
    }
  }
}

/** Head accessories drawn last, over the face/hair (v2.12). */
function drawAccessory(ctx, x, headY, s, personality) {
  if (personality.accessory === 'beard') {
    // A full beard framing the jaw, with the mouth redrawn on top.
    ctx.fillStyle = personality.hairColor;
    ctx.beginPath();
    ctx.moveTo(x - 9.5 * s, headY + 1 * s);
    ctx.quadraticCurveTo(x - 9 * s, headY + 12 * s, x, headY + 12.5 * s);
    ctx.quadraticCurveTo(x + 9 * s, headY + 12 * s, x + 9.5 * s, headY + 1 * s);
    ctx.quadraticCurveTo(x + 5 * s, headY + 4 * s, x, headY + 3.5 * s);
    ctx.quadraticCurveTo(x - 5 * s, headY + 4 * s, x - 9.5 * s, headY + 1 * s);
    ctx.fill();
    ctx.strokeStyle = '#f5e6d8';
    ctx.lineWidth = Math.max(1, 0.8 * s);
    ctx.beginPath();
    ctx.arc(x, headY + 4.2 * s, 1.8 * s, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  } else if (personality.accessory === 'headphones') {
    ctx.strokeStyle = '#2a2a33';
    ctx.lineWidth = Math.max(1.5, 1.8 * s);
    ctx.beginPath();
    ctx.arc(x, headY - 1 * s, 11.5 * s, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    for (const dir of [-1, 1]) drawRoundRect(ctx, x + (dir < 0 ? -14 : 9.5) * s, headY - 1.5 * s, 4.5 * s, 7 * s, 2 * s, '#e06a5b');
  } else if (personality.accessory === 'beret') {
    ctx.fillStyle = personality.accentColor;
    ctx.beginPath();
    ctx.ellipse(x + 2 * s, headY - 9.5 * s, 10.5 * s, 4 * s, -0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(x + 1.5 * s, headY - 15 * s, 1.5 * s, 2.5 * s);
  } else if (personality.accessory === 'ribbon') {
    // A hair bow (two loops + a knot) on the upper right of the head.
    const bx = x + 7 * s;
    const by = headY - 9 * s;
    ctx.fillStyle = personality.accentColor || '#ffffff';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + dir * 5 * s, by - 3 * s);
      ctx.lineTo(bx + dir * 5 * s, by + 3 * s);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(bx, by, 1.6 * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * The shared big-character draw helper: body +
 * head + hair + a personality-parameterized face. `angryTint` is Karen's
 * "reddish face tint during her scripted outburst" (doc's Visual
 * Direction), passed independently of her base template so it only applies
 * while her event is actually active.
 *
 * v2 art pass: proportions follow Kitchen Shift's `drawPixelPerson` (the
 * user: the library bodies "feel ugly" next to the kitchen's) — a wide,
 * rounded torso the head sits directly on (no separate neck to read as a
 * gap), short arms peeking out either side with hands, short legs with
 * shoes, and a soft ground shadow. Each personality also gets its own
 * hairstyle and outfit detail instead of differing by palette alone.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {object} base - a personality object (see this file's header).
 * @param {{scale?: number, angryTint?: boolean, stress?: number}} [opts]
 */
export function drawPerson(ctx, x, y, base, opts = {}) {
  // v2.16 `opts.stress` (0..1, the player's low-Sanity stress): worried
  // brows, a growing frown and smaller pupils, plus eye bags and a sweat
  // drop drawn after the face (user: "when sanity drops below 25 make the
  // facial expression change").
  const stress = Math.max(0, Math.min(1, opts.stress ?? 0));
  const personality = stress > 0
    ? {
      ...base,
      browAngle: base.browAngle + (1.1 - base.browAngle) * stress,
      mouthCurve: base.mouthCurve + (-1.3 - base.mouthCurve) * stress,
      eyeShape: stress > 0.6 ? 'roundSmall' : base.eyeShape,
      blush: base.blush && stress < 0.5,
    }
    : base;
  const s = opts.scale ?? 1;
  const pants = personality.pantsColor || personality.bodyColor;
  const headY = y - 34 * s;

  // Ground shadow.
  ctx.fillStyle = 'rgba(58,42,42,0.14)';
  ctx.beginPath();
  ctx.ellipse(x, y + 9 * s, 11 * s, 2.6 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Legs + shoes.
  drawRoundRect(ctx, x - 7 * s, y - 8 * s, 6 * s, 14 * s, 2 * s, pants);
  drawRoundRect(ctx, x + 1 * s, y - 8 * s, 6 * s, 14 * s, 2 * s, pants);
  const shoe = personality.shoeColor || '#4a3a32';
  drawRoundRect(ctx, x - 8 * s, y + 4 * s, 7.5 * s, 4.5 * s, 2 * s, shoe);
  drawRoundRect(ctx, x + 0.5 * s, y + 4 * s, 7.5 * s, 4.5 * s, 2 * s, shoe);

  // Arms (sleeves) peek ~3 units out past the torso on each side, with hands.
  const sleeve = shadeColor(personality.bodyColor, -0.08);
  drawRoundRect(ctx, x - 14 * s, y - 23 * s, 6 * s, 15 * s, 3 * s, sleeve);
  drawRoundRect(ctx, x + 8 * s, y - 23 * s, 6 * s, 15 * s, 3 * s, sleeve);
  ctx.fillStyle = personality.headColor;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + dir * 11 * s, y - 8 * s, 2.7 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  // Torso — its top tucks up under the head circle, so the head always
  // reads as attached (v1.5's floating-head report can't recur: there is
  // no neck seam at all any more).
  drawRoundRect(ctx, x - 11 * s, y - 26 * s, 22 * s, 21 * s, 6 * s, personality.bodyColor);
  drawOutfitDetail(ctx, x, y, s, personality);

  drawBackHair(ctx, x, headY, s, personality);

  ctx.fillStyle = personality.headColor;
  ctx.beginPath();
  ctx.arc(x, headY, 10 * s, 0, Math.PI * 2);
  ctx.fill();
  // Ears.
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + dir * 9.8 * s, headY + 1.5 * s, 2 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  if (personality.hairColor) drawFrontHair(ctx, x, headY, s, personality);

  drawLibraryFace(ctx, x, y, s, personality, Boolean(opts.angryTint));
  if (personality.glasses) drawGlasses(ctx, x, headY, s);
  if (personality.accessory) drawAccessory(ctx, x, headY, s, personality);
  if (stress > 0) drawStressMarks(ctx, x, headY, s, stress);
}
