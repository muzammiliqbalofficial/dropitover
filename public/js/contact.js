import { fetchJson } from './util.js';

const form = document.querySelector('#contactForm');
const status = document.querySelector('#contactStatus');
const button = form.querySelector('button[type=submit]');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  button.disabled = true;
  status.textContent = 'Saving your inquiry…';
  try {
    const result = await fetchJson('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    if (!result.ok || !result.ticketId) throw new Error('Could not confirm your inquiry. Please try again.');
    status.textContent = `Your inquiry has been saved. Ticket: ${result.ticketId}. Keep this reference for follow-up.`;
    form.reset();
  } catch (err) {
    status.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});
