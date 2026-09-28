const rows = document.querySelector('#adjustment-rows');
const template = document.querySelector('#adjustment-row-template');
document.querySelector('#add-adjustment-row')?.addEventListener('click', () => {
  if (rows.children.length < 50) rows.append(template.content.cloneNode(true));
});
rows?.addEventListener('click', event => {
  if (event.target.matches('[data-remove-adjustment]') && rows.children.length > 1) {
    event.target.closest('tr').remove();
  }
});
