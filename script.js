loadFragment('header', 'header.html');
loadFragment('footer', 'footer.html');
loadLiveDeals();

function loadFragment(id, url) {
  const target = document.getElementById(id);
  if (!target) return;

  fetch(url)
    .then((response) => response.text())
    .then((html) => {
      target.innerHTML = html;
    })
    .catch(() => {
      target.innerHTML = '';
    });
}

async function loadLiveDeals() {
  const target = document.getElementById('live-deals');
  if (!target) return;

  try {
    const response = await fetch('/api/deals');
    if (!response.ok) throw new Error('Deal API unavailable');

    const data = await response.json();
    if (!Array.isArray(data.deals) || data.deals.length === 0) {
      target.insertAdjacentHTML('beforeend', `
        <article class="info-card">
          <span class="deal-tag">Ready for RSForwarder feed</span>
          <h3>Export Amazon deals to turn this on</h3>
          <p>The backend is running, but it needs the sanitized RSForwarder Amazon deals JSON before live deals can appear.</p>
        </article>
      `);
      return;
    }

    target.innerHTML = data.deals.map(renderDealCard).join('');
  } catch {
    target.insertAdjacentHTML('beforeend', `
      <article class="info-card">
        <span class="deal-tag">Live feed offline</span>
        <h3>Showing saved deals</h3>
        <p>Start the NGKFlip backend and run the RSForwarder Amazon deals exporter to load live deals.</p>
      </article>
    `);
  }
}

function renderDealCard(deal) {
  const image = deal.image
    ? `<img class="deal-image" src="${escapeHtml(deal.image)}" alt="${escapeHtml(deal.title)}">`
    : '<div class="deal-image deal-image-empty">Deal image</div>';
  const price = deal.price ? `<span>${escapeHtml(deal.price)}</span>` : '<span>Check live deal</span>';
  const beforePrice = deal.beforePrice ? `<span>Was ${escapeHtml(deal.beforePrice)}</span>` : '';
  const discount = deal.discount ? `<span>${escapeHtml(deal.discount)}</span>` : '';
  const postedAt = deal.postedAt ? new Date(deal.postedAt).toLocaleString() : 'Recently posted';
  const merchant = deal.merchant || 'RSForwarder';

  return `
    <article class="deal-card">
      <a href="${escapeHtml(deal.affiliateUrl)}" target="_blank" rel="noopener sponsored">
        ${image}
      </a>
      <div class="deal-content">
        <span class="deal-tag">${escapeHtml(merchant)} via RSForwarder</span>
        <h3>${escapeHtml(deal.title)}</h3>
        <div class="deal-meta">
          ${price}
          ${beforePrice}
          ${discount}
          <span>${escapeHtml(postedAt)}</span>
        </div>
        ${deal.note ? `<p>${escapeHtml(deal.note)}</p>` : ''}
        <div class="card-actions">
          <a class="button primary" href="${escapeHtml(deal.affiliateUrl)}" target="_blank" rel="noopener sponsored">View deal</a>
        </div>
      </div>
    </article>
  `;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
