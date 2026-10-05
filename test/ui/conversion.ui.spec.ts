import { expect, test, type Page } from '@playwright/test';
import { startConversionFixture } from './fixtures/conversion/server.mjs';

// These are the same eight actual-component scenarios qualified manually in a
// real browser on 2026-10-05. Fake transport deliberately resolves after abort;
// production EntryForm/useCurrencyConversion/fx/conversion/entryMath stay real.
const SCENARIOS = [
  'manual rate wins over late aborted fetch; exact manual payload saved',
  'manual converted amount wins over late fetch and derives its rate',
  'currency-pair change aborts old request and accepts only new pair',
  'toggle off aborts; each later automatic enable fetches fresh quote',
  'unmount aborts pending FX without an account or network action',
  'fetch failure stays actionable; manual fallback remains usable and saves',
  'saved manual conversion retains original amount/pair and is not silently fetched',
  'unresolved selected conversion blocks submission with visible guidance',
] as const;

let fixture: Awaited<ReturnType<typeof startConversionFixture>>;
let pageErrors: string[], unexpectedRequests: string[];

test.beforeAll(async () => { fixture = await startConversionFixture(); });
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async ({ page }, info) => {
  pageErrors = []; unexpectedRequests = [];
  const allowed = new Set(fixture.manifest.assets.map(asset => asset.url));
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === fixture.origin && !url.search && allowed.has(url.pathname) && request.method() === 'GET') {
      await route.continue();
    } else {
      unexpectedRequests.push(request.method() + ' ' + request.url());
      await route.abort('blockedbyclient');
    }
  });
  await info.attach('synthetic-fixture-source', {
    body: JSON.stringify(fixture.manifest, null, 2), contentType: 'application/json',
  });
});
test.afterEach(() => {
  expect(pageErrors, 'Real mounted component must not throw').toEqual([]);
  expect(unexpectedRequests, 'Only the six local fixture assets may be requested').toEqual([]);
});

async function run(page: Page, selected: typeof SCENARIOS[number] | 'all') {
  await page.goto(fixture.origin);
  await expect(page.locator('#subject form')).toBeVisible();
  await page.getByLabel('Scenario', { exact: true }).selectOption(selected);
  await page.getByRole('button', { name: 'Run selected tests', exact: true }).click();
  const output = page.locator('#output');
  await expect(output).toHaveAttribute('data-complete', 'true');
  const result = JSON.parse(await output.innerText());
  const expected = selected === 'all' ? [...SCENARIOS] : [selected];
  // Neither an empty failure list nor an empty test run counts as success.
  expect(result.expectedTests).toBe(expected.length);
  expect(result.completed).toBe(true);
  expect(result.checks).toEqual(expected);
  expect(result.failures).toEqual([]);
  expect(result.passed).toBe(true);
  expect(result.noRealNetwork).toBe(true);
  expect(result.noAccountsOrStorage).toBe(true);
  expect(result.pending).toBe(0);
}

for (const scenario of SCENARIOS) {
  test(scenario, async ({ page }) => { await run(page, scenario); });
}

test('all eight scenarios and the 390px conversion checkbox remain aligned without overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await run(page, 'all');
  await page.getByRole('button', { name: 'Toggle 390px width', exact: true }).click();
  const geometry = await page.locator('#subject').evaluate(subject => {
    const form = subject.querySelector('form')!;
    const checkbox = subject.querySelector('.conversion-toggle input')!.getBoundingClientRect();
    const label = subject.querySelector('.conversion-toggle > span')!.getBoundingClientRect();
    return {
      bodyOverflow: document.documentElement.scrollWidth > window.innerWidth,
      formOverflow: form.scrollWidth > form.clientWidth,
      checkboxWidth: checkbox.width, checkboxHeight: checkbox.height,
      gap: label.left - checkbox.right,
      verticalCentreDifference: Math.abs((checkbox.top + checkbox.bottom - label.top - label.bottom) / 2),
      manualFieldsInViewport: [...subject.querySelectorAll('.convert-block input')].every(field => {
        const box = field.getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth;
      }),
    };
  });
  expect(geometry.bodyOverflow).toBe(false);
  expect(geometry.formOverflow).toBe(false);
  expect(geometry.checkboxWidth).toBe(18);
  expect(geometry.checkboxHeight).toBe(18);
  expect(geometry.gap).toBe(8);
  expect(geometry.verticalCentreDifference).toBeLessThanOrEqual(1);
  expect(geometry.manualFieldsInViewport).toBe(true);
  await page.screenshot({ path: info.outputPath('conversion-mobile.png'), fullPage: true });
});
