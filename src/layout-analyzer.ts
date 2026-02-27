import type { Page } from 'playwright';
import type { LayoutElement, LayoutChange } from './types.js';

export async function extractLayoutInfo(
  page: Page,
  selectors?: string[]
): Promise<LayoutElement[]> {
  return page.evaluate((sels) => {
    const elements: Array<{
      selector: string;
      tagName: string;
      id?: string;
      boundingBox: { x: number; y: number; width: number; height: number };
      styles: Record<string, string>;
    }> = [];

    function getSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      const testId = el.getAttribute('data-testid');
      if (testId) return `[data-testid="${testId}"]`;
      const role = el.getAttribute('role');
      if (role) return `[role="${role}"]`;
      const tag = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (!parent) return tag;
      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      if (siblings.length === 1) return `${getSelector(parent)} > ${tag}`;
      const index = siblings.indexOf(el) + 1;
      return `${getSelector(parent)} > ${tag}:nth-child(${index})`;
    }

    function processElement(el: Element) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const computed = window.getComputedStyle(el);
      elements.push({
        selector: getSelector(el),
        tagName: el.tagName.toLowerCase(),
        id: el.id || undefined,
        boundingBox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        styles: {
          display: computed.display,
          position: computed.position,
          fontSize: computed.fontSize,
          color: computed.color,
          backgroundColor: computed.backgroundColor,
          margin: computed.margin,
          padding: computed.padding,
        },
      });
    }

    if (sels && sels.length > 0) {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) processElement(el);
      }
    } else {
      // Auto-discover key elements
      const semantic = 'header,nav,main,footer,section,article,aside,h1,h2,h3,button,a,img,form,input,table';
      const discovered = new Set<Element>();

      document.querySelectorAll(semantic).forEach(el => discovered.add(el));
      document.querySelectorAll('[id]').forEach(el => discovered.add(el));
      document.querySelectorAll('[data-testid]').forEach(el => discovered.add(el));
      document.querySelectorAll('[role]').forEach(el => discovered.add(el));

      discovered.forEach(el => processElement(el));
    }

    return elements;
  }, selectors ?? null);
}

export function compareLayouts(
  before: LayoutElement[],
  after: LayoutElement[]
): LayoutChange[] {
  const changes: LayoutChange[] = [];
  const beforeMap = new Map(before.map(el => [el.selector, el]));
  const afterMap = new Map(after.map(el => [el.selector, el]));

  // Check for removed elements
  for (const [selector, el] of beforeMap) {
    if (!afterMap.has(selector)) {
      changes.push({
        selector,
        type: 'removed',
        description: `Element ${selector} (${el.tagName}) was removed`,
        before: el,
      });
    }
  }

  // Check for added elements
  for (const [selector, el] of afterMap) {
    if (!beforeMap.has(selector)) {
      changes.push({
        selector,
        type: 'added',
        description: `Element ${selector} (${el.tagName}) was added`,
        after: el,
      });
    }
  }

  // Check for moved/resized/styled elements
  for (const [selector, afterEl] of afterMap) {
    const beforeEl = beforeMap.get(selector);
    if (!beforeEl) continue;

    const bb = beforeEl.boundingBox;
    const ab = afterEl.boundingBox;

    if (bb.x !== ab.x || bb.y !== ab.y) {
      changes.push({
        selector,
        type: 'moved',
        description: `${selector} moved from (${bb.x},${bb.y}) to (${ab.x},${ab.y})`,
        before: beforeEl,
        after: afterEl,
      });
    }

    if (bb.width !== ab.width || bb.height !== ab.height) {
      changes.push({
        selector,
        type: 'resized',
        description: `${selector} resized from ${bb.width}x${bb.height} to ${ab.width}x${ab.height}`,
        before: beforeEl,
        after: afterEl,
      });
    }

    // Check style changes
    const styleChanges: string[] = [];
    for (const [prop, beforeVal] of Object.entries(beforeEl.styles)) {
      const afterVal = afterEl.styles[prop];
      if (beforeVal !== afterVal) {
        styleChanges.push(`${prop}: "${beforeVal}" → "${afterVal}"`);
      }
    }
    if (styleChanges.length > 0) {
      changes.push({
        selector,
        type: 'style_changed',
        description: `${selector} style changes: ${styleChanges.join(', ')}`,
        before: beforeEl,
        after: afterEl,
      });
    }
  }

  return changes;
}
