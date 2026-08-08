import { expect, test } from '@playwright/test';

test('customer to AI to human takeover to browser WebRTC connection', async ({ browser }) => {
  const customerContext = await browser.newContext({ permissions: ['microphone'] });
  const ownerContext = await browser.newContext({ permissions: ['microphone'] });
  const customerPage = await customerContext.newPage();
  const ownerPage = await ownerContext.newPage();

  await customerPage.goto('/');
  await customerPage.getByLabel('Your name').fill('Test Customer');
  await customerPage.getByLabel('How can we help you?').fill('I need help with a product.');
  await customerPage.getByRole('button', { name: 'Start chatting' }).click();
  await expect(customerPage.getByText(/do not have enough verified Electricalskart information/i)).toBeVisible();
  await expect(customerPage.getByText(/Connecting to a support agent/i)).toBeVisible();

  await ownerPage.goto('/login');
  await ownerPage.getByLabel('Email').fill('owner@e2e.test');
  await ownerPage.getByLabel('Password').fill('E2EOwnerPassword!123');
  await ownerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(ownerPage).toHaveURL(/\/dashboard/);
  await ownerPage.getByRole('link', { name: /Live Chat/ }).click();
  const customerRow = ownerPage.getByRole('button', { name: /Test Customer/ });
  await expect(customerRow).toBeVisible();
  await customerRow.click();
  await expect(ownerPage.getByText('I need help with a product.').last()).toBeVisible();

  await ownerPage.getByRole('button', { name: 'Take over' }).click();
  await expect(customerPage.getByText(/is here to help|Support agent online/i)).toBeVisible();
  const humanReply = 'Hello Test Customer, I am a human support representative.';
  await ownerPage.locator('textarea').fill(humanReply);
  await ownerPage.getByRole('button', { name: 'Send' }).click();
  await expect(customerPage.getByText(humanReply)).toBeVisible();

  await customerPage.getByRole('button', { name: /Talk to Support/ }).click();
  await expect(ownerPage.getByText('Incoming Customer Call')).toBeVisible();
  await expect(ownerPage.getByText(/Test Customer/).last()).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Accept' }).click();

  await expect(ownerPage.getByText(/Connected —/)).toBeVisible({ timeout: 20_000 });
  await expect(customerPage.getByText(/Connected —/)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => ownerPage.locator('audio[playsinline]').evaluate(audio => audio.srcObject?.getAudioTracks().length || 0)).toBeGreaterThan(0);
  await expect.poll(() => customerPage.locator('audio[playsinline]').evaluate(audio => audio.srcObject?.getAudioTracks().length || 0)).toBeGreaterThan(0);

  await ownerPage.getByRole('button', { name: 'End call' }).click();
  await expect(customerPage.getByText(/Call ended/)).toBeVisible();

  await customerContext.close();
  await ownerContext.close();
});
