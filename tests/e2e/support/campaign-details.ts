import { expect, type Page } from '@playwright/test';

export async function campaignDetails(page: Page, open = true) {
  const details = page.getByTestId('campaign-details');
  await expect(details).toBeAttached();
  if ((await details.getAttribute('open')) !== (open ? '' : null))
    await details.locator(':scope > summary').click();
  if (open) await expect(details).toHaveAttribute('open', '');
  else await expect(details).not.toHaveAttribute('open', '');
}
