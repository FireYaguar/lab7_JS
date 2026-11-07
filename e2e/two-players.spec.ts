import { type Browser, expect, type Page, test } from '@playwright/test'

// Два окремі контексти браузера = два гравці. Входять в одну кімнату через ?room=…&name=…
async function join(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await page.goto(`/?room=classic&name=${name}`)
  await page.waitForFunction(() => '__net' in window && window.__net !== undefined)
  return page
}

// Позиції ЧУЖИХ кораблів очима гравця (те, що він малює на екрані)
function remoteShips(page: Page): Promise<{ x: number; y: number }[]> {
  return page.evaluate(() =>
    (window.__net?.items(0) ?? []).flatMap((it) =>
      it.kind === 'ship' && !it.mine ? [{ x: it.x, y: it.y }] : [],
    ),
  )
}

test('другий гравець бачить рух першого і отримує його повідомлення в чаті', async ({
  browser,
}) => {
  const alice = await join(browser, 'Alice')
  const bob = await join(browser, 'Bob')

  // у Боба є хоча б 2 чужі кораблі: Аліса і дрон
  await expect.poll(async () => (await remoteShips(bob)).length).toBeGreaterThanOrEqual(2)
  const before = await remoteShips(bob)

  // Аліса тисне газ 1.5 с (дрон без газу лише крутиться на місці)
  await alice.locator('canvas').first().click()
  await alice.keyboard.down('KeyW')
  await alice.waitForTimeout(1500)
  await alice.keyboard.up('KeyW')

  await expect
    .poll(async () => {
      const after = await remoteShips(bob)
      // максимальне зміщення будь-якого чужого корабля відносно найближчої старої позиції
      return Math.max(
        ...after.map((a) => Math.min(...before.map((b) => Math.hypot(a.x - b.x, a.y - b.y)))),
      )
    })
    .toBeGreaterThan(40)

  // чат: Аліса пише — у Боба з’являється повідомлення
  const text = `привіт ${Date.now()}`
  await alice.keyboard.press('Enter')
  await alice.locator('.chat-input').fill(text)
  await alice.locator('.chat-input').press('Enter')
  await expect(bob.locator('.chat-log')).toContainText(text)
  await expect(bob.locator('.chat-log')).toContainText('Alice')
})
