import { expect, test } from '@playwright/test';

test('home page has the sample-app title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('sample-app');
});
