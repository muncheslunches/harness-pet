// Notices a shake while something is being dragged: the drag doubling back on
// itself several times in quick succession, sideways or up and down.

// feed(x, y, t) returns true once per shake, then starts counting afresh.
function create({ turns = 4, within = 1000, travel = 28 } = {}) {
  const axes = [{ dir: 0, extreme: null }, { dir: 0, extreme: null }];
  let times = [];
  return {
    feed(x, y, t) {
      let turned = false;
      for (const [axis, v] of [[axes[0], x], [axes[1], y]]) {
        if (axis.extreme === null) { axis.extreme = v; continue; }
        const d = v - axis.extreme;
        if (!axis.dir) {
          if (Math.abs(d) >= travel) { axis.dir = Math.sign(d); axis.extreme = v; }
        } else if (Math.sign(d) === axis.dir) {
          axis.extreme = v; // still going the same way: the turning point moves with it
        } else if (Math.abs(d) >= travel) {
          axis.dir = -axis.dir;
          axis.extreme = v;
          turned = true;
        }
      }
      if (!turned) return false;
      times = times.filter((at) => t - at <= within);
      times.push(t);
      if (times.length < turns) return false;
      times = [];
      return true;
    },
  };
}

module.exports = { create };
