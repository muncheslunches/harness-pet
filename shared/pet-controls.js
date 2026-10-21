// Shared rules for the pet's buttons and bubble, used by Studio and the host.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetControls = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const buttons = (inst) => [0, 1].map((i) => inst?.buttons?.[i] === null ? null : inst?.buttons?.[i] ?? i);
  const hasButtons = (inst) => buttons(inst).some((b) => b !== null);
  function bubbleMode(inst) {
    if (inst?.barMode === 'off') return 'off';
    return hasButtons(inst) && inst?.barMode !== 'mini' ? 'expanded' : 'mini';
  }
  function animationEnabled(inst, manifest, key) {
    if (key === 'idle') return true;
    const animation = manifest?.animations?.[key];
    return !!animation && !(inst?.animOff?.[key] ?? animation.enabled === false);
  }
  function petName(inst, manifest) {
    const base = manifest?.name || String(inst?.pet || 'Pet').split(/[\\/]/).pop().replace(/^builtin:/, '').replace(/\.pet\.js$/, '');
    return inst?.instanceNumber > 1 ? `${base} ${inst.instanceNumber}` : base;
  }
  // What a pet says when it gets out of the way of text. A pet's own `lines` (its personality)
  // win; these are for pets that don't have any.
  const DEFAULT_LINES = {
    dodge: ['Out of your way!', 'Making room!', 'Scooting over!'],
    command: ['Okay, moving!', 'Got it, going!', 'Right away!'],
    panic: ['No room! Eek!', 'Where do I go?!', 'Text everywhere!'],
  };
  // kind: 'typing' | 'phrase'. Always returns something.
  function avoidLine(manifest, kind, panic, random = Math.random) {
    const key = panic ? 'panic' : kind === 'phrase' ? 'command' : 'dodge';
    const own = manifest?.lines?.[key];
    const list = own && own.length ? own : DEFAULT_LINES[key];
    return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  }
  return { buttons, hasButtons, bubbleMode, animationEnabled, petName, avoidLine, DEFAULT_LINES };
});
