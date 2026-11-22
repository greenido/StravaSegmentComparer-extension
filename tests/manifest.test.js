// The manifest is what users are asked to trust at install time, so the
// permission set is asserted rather than left to review.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('manifest permissions', () => {
  it('asks for storage and the right-click menu, and nothing else', () => {
    // Neither shows a warning at install.
    expect(manifest.permissions).toEqual(['storage', 'contextMenus']);
  });

  it('puts the Compare button on activity pages only', () => {
    const button = manifest.content_scripts.find(entry => entry.js.includes('page-button.js'));
    expect(button.matches).toEqual(['https://www.strava.com/activities/*']);
  });

  it('does not ask for the tabs permission', () => {
    // "tabs" shows as "Read your browsing history" at install. The host
    // permission below already grants tab.url for strava.com tabs, which is
    // all auto-detection needs.
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.host_permissions).toEqual(['https://www.strava.com/*']);
  });
});

describe('manifest version', () => {
  it('agrees with package.json', () => {
    const pad = version => [...version.split('.'), '0', '0'].slice(0, 3).join('.');
    expect(pad(manifest.version)).toBe(pad(pkg.version));
  });
});
