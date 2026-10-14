import { expect, test } from '@playwright/test';

// Fails when the server is started with ATTESTED_SAMPLE_BREAK=1.
test('home page greets the visitor', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello from sample-app');
});
