// Small real-browser check of the new editors, using only an owned no-network script resource.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), local=resolve(root,'.local');
const require=createRequire(resolve(root,'web/package.json'));const {chromium,expect}=require('@playwright/test');
let browser, context, providerId, csrf, base;let stage='login';
try {
  ({base}=JSON.parse(await readFile(resolve(local,'deployment.json'),'utf8')));
  const admin=JSON.parse(await readFile(resolve(local,'admin.json'),'utf8'));
  browser=await chromium.launch({channel:'chrome',headless:true});context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(15000);
  async function response(path,method,action){const result=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()===method);const [r]=await Promise.all([result,action()]);expect(r.status()).toBe(method==='POST'&&path==='/api/admin/providers'?201:200);return(await r.json()).data;}
  await page.goto(base);await page.locator('#loginForm_tenant').fill(admin.tenant);await page.locator('#loginForm_username').fill(admin.username);await page.locator('#loginForm_password').fill(admin.password);
  const session=await response('/api/admin/auth/login','POST',()=>page.getByRole('button',{name:/登\s*录/}).click());csrf=session.csrf_token;
  await page.goto(base+'/?tab=providers');stage='script-editor';
  await page.getByRole('button',{name:'配置脚本供应商',exact:true}).click();let dialog=page.getByRole('dialog',{name:'部署者注册的脚本通道'});
  const name='UI editor check '+randomUUID().slice(0,8);await dialog.locator('#name').fill(name);await dialog.locator('#channel_id').click();await page.locator('.ant-select-dropdown:visible').getByText('本机脚本示例（无网络） (local-demo)',{exact:true}).click();
  await dialog.locator('#params').fill('{"prefix":"UI fixture"}');const created=await response('/api/admin/providers','POST',()=>dialog.getByRole('button',{name:'保存脚本供应商'}).click());providerId=created.id;expect(created.options).toEqual({channel_id:'local-demo',params:{prefix:'UI fixture'}});
  stage='pool-editor';let row=page.getByRole('row').filter({hasText:name});await row.getByRole('button',{name:'上游 Key 池'}).click();dialog=page.getByRole('dialog',{name:'上游 Key 池：'+name});
  for(let index=0;index<2;index++){await dialog.getByRole('button',{name:'添加上游 Key'}).click();await dialog.locator(`#keys_${index}_label`).fill('UI '+index);await dialog.locator(`#keys_${index}_secret`).fill('fake-ui-pool-'+index);}
  let updated=await response('/api/admin/providers/'+providerId,'PATCH',()=>dialog.getByRole('button',{name:'保存 Key 池'}).click());expect(updated.key_pool).toHaveLength(2);expect(JSON.stringify(updated)).not.toContain('fake-ui-pool');
  await row.getByRole('button',{name:'上游 Key 池'}).click();dialog=page.getByRole('dialog',{name:'上游 Key 池：'+name});await expect(dialog.locator('#keys_0_secret')).toHaveValue('');await dialog.locator('#keys_0_enabled').click();
  updated=await response('/api/admin/providers/'+providerId,'PATCH',()=>dialog.getByRole('button',{name:'保存 Key 池'}).click());expect(updated.key_pool.map(k=>k.enabled)).toEqual([false,true]);
  await expect(dialog).toBeHidden();
  await page.screenshot({path:resolve(local,'editors.png'),fullPage:true});
  await writeFile(resolve(local,'editor-report.json'),JSON.stringify({script_editor:'passed',pool_editor:'passed',disabled_update:'passed',real_provider_runs:0},null,2));
  console.log('LOCAL_EDITORS_PASSED');
} catch {console.error('LOCAL_EDITORS_FAILED stage='+stage);process.exitCode=1;}
finally {
  if(context&&providerId&&csrf){
    const session=await context.request.get(base+'/api/admin/auth/session',{headers:{origin:base}});
    const fresh=(await session.json()).data.csrf_token;
    const r=await context.request.delete(base+'/api/admin/providers/'+providerId,{headers:{origin:base,'x-csrf-token':fresh}});
    if(r.status()!==200){console.error('LOCAL_EDITOR_RESOURCE_CLEANUP_FAILED');process.exitCode=1;}
    else console.log('LOCAL_EDITOR_RESOURCE_REMOVED id='+providerId);
  }
  await browser?.close();
}
