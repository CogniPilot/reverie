/**
 * Static checks on chat-app.css for the phone layout, where a drawer that is "closed" must be fully
 * off-screen and unreachable (an earlier version left a strip of the sidebar over the conversation).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';

const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-app.css'), 'utf8');
const root = postcss.parse(css);

function phoneRules(): postcss.Rule[] {
  const out: postcss.Rule[] = [];
  root.walkAtRules('media', (at) => {
    if (/max-width:\s*767px/.test(at.params)) at.walkRules((r) => out.push(r));
  });
  return out;
}
const decl = (rules: postcss.Rule[], selector: string, prop: string): string | undefined => {
  let found: string | undefined;
  for (const r of rules) {
    if (r.selectors.includes(selector)) r.walkDecls(prop, (d) => (found = d.value));
  }
  return found;
};

describe('phone drawers', () => {
  const rules = phoneRules();
  // A viewport 390px wide: the rail is 64px and the sidebar takes the rest up to 260px.
  const rail = 64;
  const side = Math.min(260, 390 - rail);
  const px = (v: string | undefined, width: number): number => {
    if (!v) return 0;
    const m = v.match(/translateX\((.+)\)$/);
    const expr = (m ? m[1] : v)
      .replace(/var\(--ca-rail\)/g, `${rail}px`)
      .replace(/var\(--ca-side\)/g, `${side}px`)
      .replace(/calc\(/g, '(')
      .replace(/(-?\d+(?:\.\d+)?)%/g, (_x, n) => `(${n}*${width}/100)`)
      .replace(/(-?\d+(?:\.\d+)?)px/g, '$1');
    // eslint-disable-next-line no-new-func
    return Function(`"use strict"; return (${expr});`)() as number;
  };

  it.each([
    ['.ca-rail', rail],
    ['.ca-side', side],
    ['.ca-user', rail + side],
  ])('%s sits entirely off the left edge when closed, and cannot be tabbed to', (selector, width) => {
    const left = px(decl(rules, selector, 'left') ?? '0', width);
    const shift = px(decl(rules, selector, 'transform'), width);
    // Its right edge is at or before x = 0, so no strip of it can bleed over the conversation.
    expect(left + width + shift).toBeLessThanOrEqual(0);
    expect(decl(rules, selector, 'position')).toBe('fixed');
    // The shared rule for all three hides them while closed.
    const hidden = rules.some(
      (r) =>
        r.selectors.includes(selector) &&
        r.nodes.some((n) => n.type === 'decl' && n.prop === 'visibility' && n.value === 'hidden')
    );
    expect(hidden).toBe(true);
  });

  it('shows all three again when the channels drawer is open', () => {
    const open = rules.filter(
      (r) =>
        r.selector.includes("data-drawer='channels'") &&
        r.nodes.some((n) => n.type === 'decl' && n.prop === 'visibility')
    );
    expect(open.length).toBeGreaterThan(0);
    expect(open[0].selectors.some((s) => s.includes('.ca-side'))).toBe(true);
    expect(open[0].toString()).toContain('visibility: visible');
  });
});

describe('the member drawer below desktop width', () => {
  it('is moved off the right edge and hidden while closed', () => {
    let hidden = false;
    root.walkAtRules('media', (at) => {
      if (!/max-width:\s*899px/.test(at.params)) return;
      at.walkRules('.ca-members', (r) => {
        r.walkDecls('visibility', (d) => (hidden = d.value === 'hidden'));
      });
    });
    expect(hidden).toBe(true);
  });
});

describe('the message box', () => {
  it('has no recipient picker: the channel decides who reads a message', () => {
    const all: postcss.Rule[] = [];
    root.walkRules((r) => all.push(r));
    expect(decl(all, '.ca-root .chatroom-to', 'display')).toBe('none');
  });
});

describe('theme tokens', () => {
  it('are defined on :root too, because menus, cards, dialogs and the settings page live outside .ca-root', () => {
    const rootDecls = new Set<string>();
    root.walkRules((r) => {
      if (r.selectors.includes(':root')) r.walkDecls((d) => rootDecls.add(d.prop));
    });
    for (const token of [
      '--ca-main-bg',
      '--ca-side-bg',
      '--ca-composer-bg',
      '--ca-line',
      '--ca-hover',
      '--ca-active',
    ]) {
      expect(rootDecls.has(token), token).toBe(true);
    }
  });

  it('every --ca- token used by something appended to <body> has a :root definition', () => {
    const defined = new Set<string>();
    root.walkRules((r) => {
      if (r.selectors.includes(':root')) r.walkDecls((d) => defined.add(d.prop));
    });
    const used = new Set<string>();
    root.walkRules((r) => {
      // rules scoped under .ca-root are inside the grid; the rest render in <body>
      if (r.selectors.every((sel) => /^\.ca-root\b/.test(sel) || /^#chatApp/.test(sel))) return;
      r.walkDecls((d) => {
        for (const m of d.value.matchAll(/var\((--ca-[a-z-]+)/g)) used.add(m[1]);
      });
    });
    for (const t of used) expect(defined.has(t) || ['--ca-vh', '--ca-vtop', '--ca-depth'].includes(t), t).toBe(true);
  });
});

describe('phones and touch screens', () => {
  const all: postcss.Rule[] = [];
  root.walkRules((r) => all.push(r));
  const inMedia = (test: RegExp): postcss.Rule[] => {
    const out: postcss.Rule[] = [];
    root.walkAtRules('media', (at) => {
      if (test.test(at.params)) at.walkRules((r) => out.push(r));
    });
    return out;
  };

  it('turns menus into bottom sheets on a phone, with big rows', () => {
    const phone = inMedia(/max-width:\s*767px/);
    expect(decl(phone, '.ca-popmenu', 'bottom')).toBe('0');
    expect(decl(phone, '.ca-popmenu', 'left')).toContain('0');
    expect(decl(phone, '.ca-popmenu button', 'min-height')).toBe('48px');
  });

  it('has no hover toolbar on touch, and 44px targets on a coarse pointer', () => {
    expect(decl(inMedia(/hover:\s*none/), '.ca-root .ca-msg-actions', 'display')).toBe('none');
    const coarse = inMedia(/pointer:\s*coarse/);
    expect(
      decl(coarse, '.ca-root .ca-item, .ca-root .ca-cat', 'min-height') ??
        decl(coarse, '.ca-root .ca-item', 'min-height')
    ).toBe('44px');
    expect(decl(coarse, '.ca-root .ca-icon-btn', 'min-height')).toBe('44px');
  });

  it('keeps form fields at 16px on a phone so the browser does not zoom', () => {
    expect(decl(inMedia(/max-width:\s*767px/), '.ca-root .chatroom-input', 'font-size')).toBe('16px');
  });
});

describe('layers: what is appended to <body> must be above the shell', () => {
  // .ca-root is a fixed layer; a body-level screen or menu with a lower z-index opens BEHIND it, invisible, while the page behind
  // it is inert, which looks like a frozen app (the channel settings did exactly that).
  const zOf = (sel: string): number[] => {
    const out: number[] = [];
    root.walkRules((r) => {
      if (r.selectors.includes(sel)) r.walkDecls('z-index', (d) => out.push(Number(d.value)));
    });
    return out;
  };
  const shell = zOf('.ca-root').at(-1) as number;

  it('the shell is a fixed layer with an explicit z-index', () => {
    expect(Number.isFinite(shell)).toBe(true);
  });

  it.each(['.ca-settings', '.ca-menu', '.ca-profile', '.ca-menu.ca-msg-menu'])(
    '%s is never given a z-index at or below the shell',
    (sel) => {
      const zs = zOf(sel);
      for (const z of zs) expect(z).toBeGreaterThan(shell);
    }
  );

  it('the settings screen and the menus do have a z-index of their own', () => {
    expect(zOf('.ca-settings').at(-1)).toBeGreaterThan(shell);
    expect(zOf('.ca-menu').at(-1)).toBeGreaterThan(shell);
  });
});

describe('message text is shown exactly as written', () => {
  const decls = (sel: string): Record<string, string> => {
    const out: Record<string, string> = {};
    root.walkRules((r) => {
      if (r.selectors.includes(sel)) r.walkDecls((d) => void (out[d.prop] = d.value));
    });
    return out;
  };
  it.each(['.ca-root .chatroom-msg-text', '.ca-root .ca-msg-body', '.ca-root .ca-poll'])(
    '%s has ligatures and contextual alternates off',
    (sel) => {
      const d = decls(sel);
      expect(d['font-variant-ligatures']).toBe('none');
      expect(d['font-feature-settings']).toContain("'calt' 0");
      expect(d['font-feature-settings']).toContain("'liga' 0");
    }
  );
});

describe('the badge on a workspace picture', () => {
  const declsOf = (sel: string) => {
    const out: Record<string, string> = {};
    postcss.parse(css).walkRules((r) => {
      if (r.selectors.includes(sel)) r.walkDecls((d) => void (out[d.prop] = d.value));
    });
    return out;
  };
  it('is not clipped: the picture button does not hide overflow, and the badge has a ring to read on the picture', () => {
    expect(declsOf('.ca-rail-btn.has-image').overflow).toBeUndefined();
    expect(declsOf('.ca-rail-img')['border-radius']).toBe('inherit');
    expect(declsOf('.ca-rail-ind .ca-count')['box-shadow']).toContain('var(--ca-rail-bg)');
    expect(declsOf('.ca-rail-ind').position).toBe('absolute');
  });
});

describe('the profile card sheet', () => {
  const declsOf = (sel: string) => {
    const out: Record<string, string> = {};
    postcss.parse(css).walkRules((r) => {
      if (r.selectors.includes(sel)) r.walkDecls((d) => void (out[d.prop] = d.value));
    });
    return out;
  };
  it('spans the screen with 8px at both sides, sits at the bottom, scrolls inside and keeps clear of the home bar', () => {
    const d = declsOf('.ca-profile.ca-profile--sheet');
    expect(d.left).toBe('8px');
    expect(d.right).toBe('8px');
    expect(d.top).toBe('auto');
    expect(d.width).toBe('auto');
    expect(d.bottom).toContain('env(safe-area-inset-bottom');
    expect(d['max-height']).toContain('80vh');
    expect(declsOf('.ca-profile')['overflow-y']).toBe('auto');
  });
});

describe('polls take little room', () => {
  const rules = (sel: string) => {
    const out: Array<Record<string, string>> = [];
    postcss.parse(css).walkRules((r) => {
      if (r.selectors.includes(sel)) {
        const d: Record<string, string> = {};
        r.walkDecls((x) => void (d[x.prop] = x.value));
        out.push(d);
      }
    });
    return out;
  };
  const px = (v: string | undefined) => parseFloat(v ?? 'NaN');
  const all = (sel: string, prop: string) =>
    rules(sel)
      .map((d) => px(d[prop]))
      .filter((n) => !Number.isNaN(n));

  const has = (sel: string, prop: string) => rules(sel).find((d) => d[prop] !== undefined)?.[prop];

  it('keeps the card, the question, the rows and the footer tight, but every option still a comfortable tap target', () => {
    expect(has('.ca-root .ca-poll', 'padding')).toBe('8px 10px');
    expect(px(has('.ca-root .ca-poll-q', 'margin')!.split(' ')[2])).toBeLessThanOrEqual(6);
    expect(px(has('.ca-root .ca-poll-q', 'font-size'))).toBeLessThanOrEqual(15);
    expect(px(has('.ca-root .ca-poll-foot', 'margin-top'))).toBeLessThanOrEqual(4);
    // every option row, on any width, is between 36px (a real tap target) and 40px
    for (const h of all('.ca-root .ca-poll-opt', 'min-height')) {
      expect(h).toBeGreaterThanOrEqual(36);
      expect(h).toBeLessThanOrEqual(40);
    }
    for (const h of all('.ca-root .ca-poll-close', 'min-height')) {
      expect(h).toBeGreaterThanOrEqual(32);
      expect(h).toBeLessThanOrEqual(36);
    }
    expect(px(has('.ca-root .ca-poll-options', 'gap'))).toBeLessThanOrEqual(4);
  });
});

describe('Add people is visible', () => {
  const rules = (sel: string) => {
    const out: Array<Record<string, string>> = [];
    postcss.parse(css).walkRules((r) => {
      if (r.selectors.includes(sel)) {
        const d: Record<string, string> = {};
        r.walkDecls((x) => void (d[x.prop] = x.value));
        out.push(d);
      }
    });
    return out;
  };
  it('the open channel shows its row icons without a hover, and the header button is never hidden by a rule', () => {
    expect(rules('.ca-item-wrap.is-active .ca-item-act').some((d) => d.display === 'inline-flex')).toBe(true);
    expect(rules('.ca-root .ca-head-invite').some((d) => d.flex === 'none')).toBe(true);
    // a hidden header button (a direct message) is hidden by the attribute, not by a display:none that hides it everywhere
    expect(rules('.ca-root .ca-head-invite').every((d) => d.display !== 'none')).toBe(true);
  });
  it('keeps a real tap target on a touch screen', () => {
    expect(css).toMatch(/\.ca-root \.ca-icon-btn \{ min-width: 44px; min-height: 44px; \}/);
    expect(css).toMatch(/\.ca-item-act \{ width: 36px; height: 36px; \}/);
  });
});

describe('channel visibility choice', () => {
  const find = (sel: string): postcss.Rule | undefined => {
    let hit: postcss.Rule | undefined;
    root.walkRules((r) => {
      if (r.selectors.includes(sel)) hit = r;
    });
    return hit;
  };
  const value = (r: postcss.Rule | undefined, prop: string): string | undefined => {
    let v: string | undefined;
    r?.walkDecls(prop, (d) => (v = d.value));
    return v;
  };

  it('gives each choice a 44px tap target and a border', () => {
    const row = find('.ca-visibility .ca-radio');
    expect(value(row, 'min-height')).toBe('44px');
    expect(value(row, 'border')).toBeTruthy();
    expect(value(row, 'padding')).toBeTruthy();
  });

  it('keeps the radio at a fixed size so a generic input rule cannot stretch it', () => {
    const input = find('.ca-visibility .ca-radio input');
    expect(value(input, 'width')).toBe('20px');
    expect(value(input, 'flex')).toBe('0 0 auto');
  });

  it('marks the chosen tile', () => {
    expect(find('.ca-visibility .ca-radio:has(input:checked)')).toBeDefined();
  });

  it('every token the visibility rules use resolves outside .ca-root (the settings page is portaled under body)', () => {
    const styles = postcss.parse(readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8'));
    const used = new Set<string>();
    const bare = new Set<string>(); // used at least once with no fallback
    root.walkRules((r) => {
      if (!r.selectors.some((s) => s.includes('.ca-visibility'))) return;
      r.walkDecls((d) => {
        for (const m of d.value.matchAll(/var\((--[\w-]+)\s*([,)])/g)) {
          used.add(m[1]);
          if (m[2] === ')') bare.add(m[1]);
        }
      });
    });
    expect([...used].sort()).toEqual(expect.arrayContaining(['--ca-hover', '--ca-line', '--text']));
    const global = (tree: postcss.Root, name: string): boolean => {
      let found = false;
      tree.walkRules((r) => {
        if (r.selectors.some((s) => s === ':root' || s === 'html')) r.walkDecls(name, () => (found = true));
      });
      return found;
    };
    for (const name of bare)
      expect(global(root, name) || global(styles, name), `${name} is defined at :root`).toBe(true);
    // A skin that restyles a token for .ca-root must restyle it for the bare page too.
    root.walkRules((r) => {
      const scoped = r.selectors.filter((s) => s.endsWith(' .ca-root'));
      if (!scoped.length) return;
      r.walkDecls((d) => {
        if (!used.has(d.prop)) return;
        for (const s of scoped) expect(r.selectors, `${d.prop} for ${s}`).toContain(s.slice(0, -' .ca-root'.length));
      });
    });
  });
});

describe('channel marks and the create picker line up', () => {
  const find = (sel: string): postcss.Rule | undefined => {
    let hit: postcss.Rule | undefined;
    root.walkRules((r) => {
      if (r.selectors.includes(sel)) hit = r;
    });
    return hit;
  };
  const value = (r: postcss.Rule | undefined, prop: string): string | undefined => {
    let v: string | undefined;
    r?.walkDecls(prop, (d) => (v = d.value));
    return v;
  };

  it('every channel mark, # or drawn, is one 20px box so the names start at the same x', () => {
    expect(value(find('.ca-hash'), 'width')).toBe('20px');
    expect(value(find('.ca-hash.is-drawn'), 'width')).toBe('20px');
    expect(value(find('.ca-hash'), 'text-align')).toBe('center');
  });

  it('the create picker\'s radio has a fixed size and the text column takes the rest', () => {
    const radio = find(".ca-create-type input[type='radio']");
    expect(value(radio, 'width')).toBe('18px');
    expect(value(radio, 'flex')).toBe('0 0 auto');
    expect(value(find('.ca-create-type-text'), 'min-width')).toBe('0');
  });
});

describe('the member card one-liners', () => {
  it('are hidden until the card\'s toggle is on, and then shown under each button', () => {
    let hidden: string | undefined;
    let shown: string | undefined;
    root.walkRules((r) => {
      if (r.selectors.includes('.ca-tip')) r.walkDecls('display', (d) => (hidden = d.value));
      if (r.selectors.includes('.ca-profile.show-tips .ca-tip')) r.walkDecls('display', (d) => (shown = d.value));
    });
    expect(hidden).toBe('none');
    expect(shown).toBe('block');
  });
});


describe('page and org panels vs the phone drawers', () => {
  const z = (selector: string): number => {
    let found = NaN;
    root.walkRules((r) => {
      if (r.selectors.includes(selector)) r.walkDecls('z-index', (d) => (found = Number(d.value)));
    });
    return found;
  };
  it('keeps Board/Plans pages and the org chart under the drawers', () => {
    const drawer = Number(decl(phoneRules(), '.ca-side', 'z-index') ?? decl(phoneRules(), '.ca-rail', 'z-index'));
    expect(drawer).toBe(3);
    expect(z('.ca-page')).toBeLessThan(drawer);
    expect(z('.ca-org')).toBeLessThan(drawer);
  });
});
