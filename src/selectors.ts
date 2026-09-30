import type { Page } from 'playwright';
// All Playwright locator knowledge lives here; page-side selectors live in dom-runtime.js.
export const locators = {
  composer: (p: Page) => [
    {name:'composer-role', locator:p.getByRole('textbox', {name:/^(Chat with ChatGPT|Message ChatGPT|Ask ChatGPT)$/i}).filter({visible:true})},
    {name:'composer-id', locator:p.locator('#prompt-textarea').filter({visible:true})},
  ],
  send: (p: Page) => [
    {name:'send-role', locator:p.getByRole('button',{name:/^Send(?: (message|prompt))?$/i}).filter({visible:true})},
    {name:'send-testid', locator:p.getByTestId('send-button').filter({visible:true})},
  ],
  history: (p: Page) => p.getByRole('navigation',{name:/^(Chat history|Home)$/}).filter({visible:true}),
  openSidebar: (p: Page) => p.getByRole('button',{name:/^(Open sidebar|Toggle sidebar)$/i}).filter({visible:true}),
};
