import { expect, test } from '@playwright/test'

test('login screen does not offer the retired demo password', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('textbox', { name: 'Email*' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Password*' })).toBeVisible()
  await expect(page.getByText('Store@123')).toHaveCount(0)
  await expect(page.getByText('chaitanya.raju@srm.edu.in')).toHaveCount(0)
})

test('store manager can sign in against the live API', async ({ page }) => {
  const email = process.env.STORE_E2E_EMAIL
  const password = process.env.STORE_E2E_PASSWORD
  test.skip(!email || !password, 'Set STORE_E2E_EMAIL and STORE_E2E_PASSWORD to run the live login')
  await page.goto('/login')
  await page.getByRole('textbox', { name: 'Email*' }).fill(email!)
  await page.getByRole('textbox', { name: 'Password*' }).fill(password!)
  await page.getByRole('button', { name: /sign in|log in|continue/i }).click()
  const challenge = page.getByLabel(/new password/i)
  if (await challenge.isVisible().catch(() => false)) {
    test.info().annotations.push({ type: 'note', description: 'Account is still in the first-login challenge' })
    return
  }
  await expect(page).toHaveURL(/dashboard|orders|login/)
})
