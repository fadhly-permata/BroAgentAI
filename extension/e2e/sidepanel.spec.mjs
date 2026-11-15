import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'e2e', 'shots'); fs.mkdirSync(out, {recursive:true});
const errors=[]; const failed=[];
const ctx = await chromium.launchPersistentContext(path.join(root,'e2e','.pw-profile'), { headless:true, args:[`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
let worker; for (const w of ctx.serviceWorkers()) worker=w;
if(!worker) worker = await ctx.waitForEvent('serviceworker').catch(()=>null);
const extId = worker ? worker.url().split('/')[2] : null;
console.log('EXT_ID=', extId, 'worker=', !!worker);
if(!extId){ console.log('FAIL no extension id'); process.exit(2); }
const page = await ctx.newPage();
page.on('pageerror', e=>{errors.push('pageerror: '+e.message);});
page.on('console', m=>{ if(m.type()==='error') errors.push('console: '+m.text()); });
await page.goto(`chrome-extension://${extId}/src/sidepanel.html`);
await page.waitForTimeout(800);
const checks = {};
checks.title = await page.title().catch(()=> '');
checks.bodyText = (await page.locator('body').innerText()).slice(0,4000);
checks.hasFooterStatus = await page.locator('text=Branch main').count();
checks.hasProviderSelect = await page.locator('#providerSel').count();
checks.hasPromptInput = await page.locator('#prompt').count();
checks.railCount = await page.locator('.rail-btn').count();
checks.overflowHidden = await page.locator('#overflowMenu.hidden').count();
// screenshots per tab
for (const tab of ['explorer','search','scm','agent','settings']) {
  await page.locator(`.rail-btn[data-tab="${tab}"]`).click();
  await page.waitForTimeout(300);
  const active = await page.locator(`#tab-${tab}.active`).count();
  if(active!==1) failed.push(`tab ${tab} not active`);
  await page.screenshot({path: path.join(out, `tab-${tab}.png`), fullPage:true});
  console.log('TAB', tab, 'active=', active);
}
// Agent: simulate
await page.locator('.rail-btn[data-tab="agent"]').click();
await page.locator('#simulateBtn').click();
await page.waitForTimeout(300);
checks.approvalVisible = await page.locator('#approvalCard:not(.hidden)').count();
await page.locator('#apAllow').click();
await page.waitForTimeout(200);
checks.approvalAfterAllow = await page.locator('#approvalCard:not(.hidden)').count();
// Explorer: open file
await page.locator('.rail-btn[data-tab="explorer"]').click();
await page.locator('[data-file="src/sidepanel.ts"]').click();
await page.waitForTimeout(200);
checks.editorVisible = await page.locator('#editorPreview:not(.hidden)').count();
checks.editorValueLen = await page.locator('#edArea').inputValue().then(v=>v.length);
// Search
await page.locator('.rail-btn[data-tab="search"]').click();
await page.locator('#searchInput').fill('sidepanel');
await page.waitForTimeout(500);
checks.searchInfo = await page.locator('#searchInfo').innerText();
// overflow menu
await page.locator('#overflowBtn').click();
checks.overflowVisible = await page.locator('#overflowMenu:not(.hidden)').count();
await page.screenshot({path: path.join(out, 'final.png'), fullPage:true});
console.log('CHECKS', JSON.stringify(checks, null, 2));
console.log('ERRORS', JSON.stringify(errors, null, 2));
console.log('FAILED', JSON.stringify(failed, null, 2));
await ctx.close();
if(failed.length || errors.length) process.exit(1);
