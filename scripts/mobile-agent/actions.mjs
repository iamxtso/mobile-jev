// The status bar and the dock are system chrome, and their controls are named only by position
// (`3 of 7 in FrameLayout`, `- -`). A model told to open a settings page picked one of them instead of
// the menu item it was looking at, so chrome stops being a tap target once an app owns the screen. On
// the launcher the dock is the app switcher, so there chrome stays tappable, and `OPEN_APP` and `HOME`
// cover the two actions that chrome would otherwise offer.
const isChrome = (node) => (node.resourceId || '').startsWith('com.android.systemui:');
// The reported package is the reliable half of this: on this ROM the tree itself sometimes comes back as
// the dock alone while the app owns the screen, and trusting the tree there would leave chrome tappable
// exactly when the model is looking for a menu it cannot see.
const chromeIsNoise = (observation) => !/launcher|systemui/i.test(observation.phone.packageName);

export function candidatesFor(observation, texts = []) {
  const actions = {};
  const quietChrome = chromeIsNoise(observation);
  for (const node of observation.elements) {
    if (quietChrome && isChrome(node)) continue;
    // An element with no text and no description is an icon: the model cannot tell one ui.2.0 from
    // another, so offering it as a choice invites a guess. TAP_POINT reaches it by geometry instead,
    // which is what a person does with an unlabelled icon.
    const named = Boolean(
      (node.text || '').trim() || (node.description || '').trim() || (node.nested || '').trim(),
    );
    // A switch is actionable by definition. This ROM's settings page marks the Wi-Fi and hotspot switches
    // `checkable` while leaving `clickable` false, so 无线网络 was never offered as a target and the model
    // pressed the only rows that were (Apple CarPlay, ICCOA Carlink) while the network stayed down.
    if (node.enabled && (node.clickable || node.editable || node.checkable) && named) {
      // A search box is a clickable container around the field, and tapping the container's right side
      // lands on the magnifier: measured on the QQ音乐 search page, that tap left the field unfocused, the
      // paste went nowhere, and the Enter that followed did nothing. The field is what a person taps.
      const field = observation.elements.find(
        (child) =>
          child.id.startsWith(`${node.id}.`) &&
          child.editable &&
          child.enabled &&
          !child.checked &&
          (child.text || child.label || ''),
      );
      actions[`tap_${node.id}`] = { type: 'tap-element', elementId: field ? field.id : node.id };
    }
  }
  actions.back = { type: 'global', name: 'back' };
  actions.home = { type: 'global', name: 'home' };
  // Derive gestures from each scrollable region instead of assuming a full-screen list.
  const scrollBounds = new Set();
  const scrollable = observation.elements.filter((e) => e.enabled && e.scrollable);
  for (const node of scrollable) {
    // Android often exposes a container and its nested list as separate scroll targets.
    // Prefer the list when it occupies most of the container, retaining small nested panes.
    const area = (b) => (b.right - b.left) * (b.bottom - b.top);
    if (
      scrollable.some(
        (child) =>
          child.id.startsWith(node.id + '.') && area(child.bounds) >= area(node.bounds) * 0.7,
      )
    )
      continue;
    const boundsKey = JSON.stringify(node.bounds);
    if (scrollBounds.has(boundsKey)) continue;
    scrollBounds.add(boundsKey);
    const { left, top, right, bottom } = node.bounds;
    const x = Math.floor((left + right) / 2),
      y = Math.floor((top + bottom) / 2);
    const x1 = Math.floor(left + (right - left) * 0.2),
      x2 = Math.floor(left + (right - left) * 0.8);
    const y1 = Math.floor(top + (bottom - top) * 0.2),
      y2 = Math.floor(top + (bottom - top) * 0.8);
    for (const [name, coords] of Object.entries({
      down: [x, y2, x, y1],
      up: [x, y1, x, y2],
      right: [x2, y, x1, y],
      left: [x1, y, x2, y],
    })) {
      actions[`scroll_${name}_${node.id}`] = {
        type: 'swipe',
        startX: coords[0],
        startY: coords[1],
        endX: coords[2],
        endY: coords[3],
        duration: 300,
        regionId: node.id,
      };
    }
  }
  if (observation.phone.isEditable) {
    actions.enter = { type: 'key', key: 'enter' };
    if (
      !observation.elements.some(
        (node) => node.password && (node.focused || node.id === observation.phone.inputElementId),
      )
    ) {
      texts.forEach((text, index) => {
        actions[`text_${index}`] = { type: 'type', text, clear: true };
      });
    }
  }
  return actions;
}

export function describeAction(action, observation) {
  if (action.type === 'open-app') return `Open ${action.appLabel || action.packageName}`;
  if (action.type === 'tap') return `Tap the screen at (${action.x}, ${action.y}).`;
  if (action.type === 'tap-element') {
    const target = observation.elements.find((e) => e.id === action.elementId);
    if (target?.editable)
      return `Focus text input: ${target.hint || target.label || target.text || 'empty input field'}.`;
    const labels = observation.elements
      .filter((e) => e.id === action.elementId || e.id.startsWith(action.elementId + '.'))
      .flatMap((e) => [e.text, e.label, e.nested])
      .filter(Boolean);
    return `Tap ${[...new Set(labels)].join(' / ') || action.elementId}.`;
  }
  if (action.type === 'drag' && action.from && action.to)
    return `Drag from (${action.from.x}, ${action.from.y}) to (${action.to.x}, ${action.to.y}).`;
  if (action.type === 'long-press' || action.type === 'double-tap' || action.type === 'drag') {
    const target = observation.elements.find((e) => e.id === action.elementId);
    const labels = observation.elements
      .filter((e) => e.id === action.elementId || e.id.startsWith(action.elementId + '.'))
      .flatMap((e) => [e.text, e.label])
      .filter(Boolean);
    const name =
      [...new Set(labels)].join(' / ') ||
      target?.resourceId ||
      action.elementId ||
      `the screen at (${action.x}, ${action.y})`;
    if (action.type === 'long-press') return `Press and hold ${name}.`;
    if (action.type === 'double-tap') return `Double tap ${name}.`;
    return `Drag ${name} ${action.direction.toLowerCase()}.`;
  }
  if (action.type === 'statusbar')
    return {
      notifications: 'Pull down the notification list.',
      settings: 'Open the quick settings panel.',
      collapse: 'Close the notification shade.',
    }[action.view];
  if (action.type === 'swipe') {
    const direction =
      action.startY > action.endY
        ? 'down'
        : action.startY < action.endY
          ? 'up'
          : action.startX > action.endX
            ? 'right'
            : 'left';
    return `Scroll ${direction} to reveal content further ${direction} in this scrollable region. Gesture: ${JSON.stringify(action)}`;
  }
  return JSON.stringify(action);
}
