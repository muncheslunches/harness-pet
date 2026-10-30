// The Cage — an ornate gilded bird cage.
// Blown up, high definition version of the Harness Pet icon.
// Transparent between the bars so caged pets inside are visible.

(function () {
  const C = {
    outline: '#4A2E10',   // dark bronze outline
    gold: '#E0A83A',      // brass / warm gold
    highlight: '#F7D680', // light gold highlight
    shade: '#A87220',     // antique gold shade
    gleam: '#FFFAE1',     // gilded gleam / luster
    darkShade: '#3B230B', // deep shadow
    barBack: 'rgba(120, 85, 30, 0.45)', // subtle rear bars for 3D depth
  };

  function drawCage(g, ctx) {
    const c = g.ctx;
    const w = g.width;
    const h = g.height;

    c.save();

    // Cage coordinates (on 96 x 108 canvas)
    const cx = 48;
    const domeApexY = 22;
    const domeBaseY = 46;
    const bodyBaseY = 94;
    const leftX = 14;
    const rightX = 82;
    const cageW = rightX - leftX;

    // 1. Subtle rear bars (back of bird cage, visible behind pets)
    const rearBarX = [24, 36, 48, 60, 72];
    c.strokeStyle = C.barBack;
    c.lineWidth = 1.5;
    for (const bx of rearBarX) {
      c.beginPath();
      // Curve up into rear dome apex
      c.moveTo(bx, bodyBaseY);
      if (c.quadraticCurveTo) c.quadraticCurveTo(bx, domeBaseY, cx, domeApexY + 4);
      else c.lineTo(cx, domeApexY + 4);
      c.stroke();
    }

    // 2. Interior perch (horizontal roost bar for caged pets)
    c.strokeStyle = C.shade;
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(leftX + 6, bodyBaseY - 8);
    c.lineTo(rightX - 6, bodyBaseY - 8);
    c.stroke();
    c.strokeStyle = C.highlight;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(leftX + 6, bodyBaseY - 9);
    c.lineTo(rightX - 6, bodyBaseY - 9);
    c.stroke();

    // 3. Hanging Ring at the very top
    const ringY = 10;
    const ringR = 7;
    // Outer bronze ring
    c.strokeStyle = C.outline;
    c.lineWidth = 4;
    c.beginPath();
    c.arc(cx, ringY, ringR, 0, Math.PI * 2);
    c.stroke();
    // Golden body ring
    c.strokeStyle = C.gold;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(cx, ringY, ringR, 0, Math.PI * 2);
    c.stroke();
    // Luster highlight on upper-left
    c.strokeStyle = C.gleam;
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(cx, ringY, ringR, -Math.PI * 0.85, -Math.PI * 0.25);
    c.stroke();

    // 4. Finial / Connector to dome apex
    c.fillStyle = C.outline;
    c.fillRect(cx - 3.5, domeApexY - 5, 7, 6);
    c.fillStyle = C.gold;
    c.fillRect(cx - 2.5, domeApexY - 4.5, 5, 5);
    c.fillStyle = C.gleam;
    c.fillRect(cx - 1.5, domeApexY - 4, 2, 4);

    // 5. Front Vertical Bars (spaced like a bird cage so pets inside are clearly seen)
    // Left-to-right cylindrical lighting: highlight on left edge, shade on right
    const frontBarX = [24, 36, 48, 60, 72];
    for (const bx of frontBarX) {
      c.save();
      // Path from bottom of cage up to dome apex
      c.beginPath();
      c.moveTo(bx, bodyBaseY);
      c.lineTo(bx, domeBaseY);
      // Curve towards apex
      if (c.quadraticCurveTo) c.quadraticCurveTo(bx, domeApexY + 8, cx, domeApexY);
      else c.lineTo(cx, domeApexY);

      // Bronze outline
      c.strokeStyle = C.outline;
      c.lineWidth = 3.5;
      c.stroke();

      // Main gold body
      c.strokeStyle = bx > 50 ? C.shade : C.gold;
      c.lineWidth = 2;
      c.stroke();

      // Highlight on left edge
      if (bx <= 48) {
        c.strokeStyle = bx === 48 ? C.gleam : C.highlight;
        c.lineWidth = 0.8;
        c.stroke();
      }
      c.restore();
    }

    // 6. Outer upright side posts
    for (const sx of [leftX, rightX]) {
      c.fillStyle = C.outline;
      c.fillRect(sx - 2, domeBaseY, 4, bodyBaseY - domeBaseY);
      c.fillStyle = sx === leftX ? C.highlight : C.shade;
      c.fillRect(sx - 1, domeBaseY, 2, bodyBaseY - domeBaseY);
    }

    // 7. Dome Arch Ribs & Outer Dome Contour
    c.save();
    c.beginPath();
    c.moveTo(leftX, domeBaseY);
    if (c.bezierCurveTo) {
      c.bezierCurveTo(leftX + 2, domeApexY - 2, rightX - 2, domeApexY - 2, rightX, domeBaseY);
    } else {
      c.lineTo(cx, domeApexY);
      c.lineTo(rightX, domeBaseY);
    }
    c.strokeStyle = C.outline;
    c.lineWidth = 4;
    c.stroke();
    c.strokeStyle = C.gold;
    c.lineWidth = 2;
    c.stroke();
    c.strokeStyle = C.highlight;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(leftX + 4, domeBaseY - 2);
    if (c.bezierCurveTo) {
      c.bezierCurveTo(leftX + 8, domeApexY, cx - 10, domeApexY, cx, domeApexY);
    } else {
      c.lineTo(cx, domeApexY);
    }
    c.stroke();
    c.restore();

    // 8. Upper Horizontal Rim (where dome meets body)
    c.fillStyle = C.outline;
    c.fillRect(leftX - 3, domeBaseY - 2, cageW + 6, 5);
    c.fillStyle = C.gold;
    c.fillRect(leftX - 2, domeBaseY - 1, cageW + 4, 3);
    c.fillStyle = C.highlight;
    c.fillRect(leftX, domeBaseY - 1, (cageW + 4) * 0.6, 1.2);
    c.fillStyle = C.gleam;
    c.fillRect(cx - 4, domeBaseY - 1, 8, 1.5);

    // 9. Middle Horizontal Band
    const midY = 66;
    c.fillStyle = C.outline;
    c.fillRect(leftX - 2, midY - 2, cageW + 4, 4);
    c.fillStyle = C.gold;
    c.fillRect(leftX - 1, midY - 1, cageW + 2, 2);
    c.fillStyle = C.highlight;
    c.fillRect(leftX, midY - 1, (cageW + 2) * 0.55, 1);
    c.fillStyle = C.gleam;
    c.fillRect(cx - 3, midY - 1.2, 6, 1.5);

    // 10. Base / Pedestal (ornate gilded tiered base)
    // Tier 1: Upper rim
    c.fillStyle = C.outline;
    c.fillRect(leftX - 4, bodyBaseY - 2, cageW + 8, 4);
    c.fillStyle = C.gold;
    c.fillRect(leftX - 3, bodyBaseY - 1, cageW + 6, 2);
    c.fillStyle = C.highlight;
    c.fillRect(leftX - 1, bodyBaseY - 1, (cageW + 6) * 0.5, 1);

    // Tier 2: Main plinth
    c.fillStyle = C.outline;
    c.fillRect(leftX - 6, bodyBaseY + 2, cageW + 12, 7);
    c.fillStyle = C.shade;
    c.fillRect(leftX - 5, bodyBaseY + 3, cageW + 10, 5);
    c.fillStyle = C.gold;
    c.fillRect(leftX - 5, bodyBaseY + 3, (cageW + 10) * 0.7, 4);
    c.fillStyle = C.highlight;
    c.fillRect(leftX - 4, bodyBaseY + 3, (cageW + 10) * 0.45, 2);

    // Tier 3: Bottom footing
    c.fillStyle = C.outline;
    c.fillRect(leftX - 8, bodyBaseY + 9, cageW + 16, 4);
    c.fillStyle = C.shade;
    c.fillRect(leftX - 7, bodyBaseY + 10, cageW + 14, 2);
    c.fillStyle = C.highlight;
    c.fillRect(leftX - 6, bodyBaseY + 10, (cageW + 14) * 0.4, 1);

    c.restore();
  }

  definePet({
    format: 1,
    id: 'cage',
    name: 'Cage',
    author: 'Harness Pet',
    version: '1.0.0',
    description: 'An ornate gilded bird cage. Holds caged pets safely inside.',
    canvas: { width: 96, height: 108 },
    scale: 1.55,
    groundY: 104,
    lines: {
      dodge: ['*rattles bars*', '*clinks softly*'],
      command: ['Gilded & secure.', 'Perch ready!'],
      panic: ['*bars creak!*', 'Don’t tip me!'],
    },
    animations: {
      idle: {
        draw(g, ctx) {
          drawCage(g, ctx);
        },
      },
    },
  });
})();
