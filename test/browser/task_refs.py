"""Isolated UI fixture: python3 test/browser/task_refs.py [screenshot-dir]. No real hub/agent."""
import asyncio
import json
from pathlib import Path
import sys
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/t7bb0-shots')

async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tasks = [
        dict(id='ta001', title='修复任务引用：用简介替代编号', status='running', machine='cloud'),
        dict(id='ta002', title='归档：清理旧截图与重复附件', status='done', archived=True, machine='cloud'),
        dict(id='ta003', title='跨机器：验证 laptop 上的构建结果', status='done', machine='laptop'),
        dict(id='ta004', title='长标题：' + '验证任务名称的可读性和完整悬浮提示' * 5, status='running', machine='cloud'),
        dict(id='ta005', title='<img src=x onerror="window.XSS=1"> & 特殊字符', status='done', machine='cloud'),
    ]
    text = '已安排 **ta001**，归档结果见 ta002，跨机器结果见 ta003。\n\n长名称 ta004；特殊字符 ta005；未知任务 tffff。\n\n代码不转换：`ta001`，链接不转换：[ta001](https://example.test/ta001)。\n\n```sh\necho ta001\n```'
    state = dict(messages=[dict(role='assistant', content=[dict(type='text', text=text)])], isStreaming=False)
    errors, requests = [], []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
        page = await browser.new_page(viewport=dict(width=1440, height=1000), device_scale_factor=1)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.add_init_script("""window.EventSource=class {constructor(){window.fixtureStream=this;setTimeout(()=>{this.onmessage?.({data:JSON.stringify({type:'front',state:STATE})});this.onopen?.()},20)}}""".replace('STATE', json.dumps(state)))
        async def route(r):
            path = r.request.url.split('fixture.test', 1)[1]
            requests.append(path)
            if path == '/':
                return await r.fulfill(content_type='text/html', body=(ROOT/'ui/app.html').read_text().replace('/*@tokens*/', (ROOT/'shared/tokens.css').read_text()))
            if path in ['/team.js', '/upgrade.js']:
                return await r.fulfill(content_type='text/javascript', body='')
            data = {}
            if path == '/api/hub/tasks':
                await asyncio.sleep(1)
                data = dict(tasks=tasks)
            elif path.startswith('/api/hub/tasks/'):
                tid = path.split('/')[4].split('?')[0]
                data = dict(task=next(t for t in tasks if t['id'] == tid), events=[])
            elif path == '/api/hub/machines':
                data = dict(self='cloud', machines=[])
            elif '/attention' in path:
                data = dict(items=[], counts={}, focus={})
            elif '/projects' in path:
                data = dict(projects=[])
            elif '/intake' in path:
                data = dict(intake=[])
            elif '/cron' in path:
                data = dict(jobs=[])
            await r.fulfill(content_type='application/json', body=json.dumps(data))
        await page.route('http://fixture.test/**', route)
        await page.goto('http://fixture.test/')
        ref = page.locator('.asst .tid[data-task="ta001"]')
        await ref.wait_for()
        assert await ref.inner_text() == '查看任务'
        await ref.evaluate('(el)=>window.originalRef=el')
        await page.wait_for_function("document.querySelector('.asst .tid').textContent==='修复任务引用：用简介替代编号'")
        assert await ref.evaluate('(el)=>el===window.originalRef')
        assert await page.locator('.asst .tid').count() == 6
        assert await page.locator('.asst img').count() == 0
        assert not await page.evaluate('window.XSS')
        assert await page.locator('.asst code').first.inner_text() == 'ta001'
        await page.screenshot(path=str(OUT/'desktop.png'), full_page=True)
        await ref.focus()
        await page.keyboard.press('Enter')
        await page.wait_for_selector('#detail.on h3')
        assert '/api/hub/tasks/ta001?events=1' in requests
        await page.screenshot(path=str(OUT/'detail.png'), full_page=True)
        await page.locator('#detail [data-back]').click()
        await page.evaluate("fixtureStream.onmessage({data:JSON.stringify({type:'agent',event:{type:'message_start',message:{role:'assistant',content:[{type:'text',text:'新回复：ta003'}]}}})})")
        assert await page.locator('.asst').last.locator('.tid').inner_text() == tasks[2]['title']
        await page.set_viewport_size(dict(width=430, height=932))
        await page.locator('#mobtabs [data-v="chat"]').click()
        await page.wait_for_timeout(350)
        await page.screenshot(path=str(OUT/'mobile.png'), full_page=True)
        assert requests.count('/api/hub/tasks') == 1
        assert not errors, errors
        print(json.dumps(dict(result='PASS', screenshots=str(OUT), task_list_requests=1, errors=errors)))
        await browser.close()

asyncio.run(main())
