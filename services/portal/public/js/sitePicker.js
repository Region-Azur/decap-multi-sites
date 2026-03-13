const dialog = document.getElementById('siteSettingsDialog');
const form = document.getElementById('siteSettingsForm');
const cancel = document.getElementById('cancelSettings');
const saveButton = document.getElementById('saveSettings');
const settingsNotice = document.getElementById('settingsNotice');
const settingsNoticeOk = document.getElementById('settingsNoticeOk');
const brandIconInput = document.getElementById('brand_icon');
const faviconInput = document.getElementById('favicon');
const brandIconFileInput = document.getElementById('brand_icon_file');
const faviconFileInput = document.getElementById('favicon_file');
const cropModal = document.getElementById('cropModal');
const cropperImage = document.getElementById('cropperImage');
const cropCancel = document.getElementById('cropCancel');
const cropConfirm = document.getElementById('cropConfirm');

let cropper = null;
let currentTargetInput = null;
let currentFileInput = null;
let userToken = null;

// Get user JWT token
async function getUserToken() {
  if (userToken) return userToken;
  
  try {
    const res = await fetch('/sites/token');
    if (!res.ok) throw new Error('Failed to get user token');
    const data = await res.json();
    userToken = data.token;
    return userToken;
  } catch (e) {
    alert('Error: Could not get authorization token. Please refresh and try again.');
    throw e;
  }
}

async function readAsDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function openCropEditor(dataUrl, targetInput, fileInput) {
  currentTargetInput = targetInput;
  currentFileInput = fileInput;
  cropperImage.src = dataUrl;
  cropModal.classList.add('active');
  cropModal.setAttribute('aria-hidden', 'false');
  if (dialog.open) dialog.close();
  if (cropper) cropper.destroy();

  cropperImage.onload = function() {
    cropper = new Cropper(cropperImage, {
      aspectRatio: 1,
      viewMode: 1,
      autoCropArea: 0.92,
      responsive: true,
      modal: true,
      guides: true,
      center: true,
      highlight: true,
      cropBoxMovable: true,
      cropBoxResizable: true,
      toggleDragModeOnDblclick: false,
      wheelZoomRatio: 0.08
    });
  };
}

function closeCropEditor() {
  cropModal.classList.remove('active');
  cropModal.setAttribute('aria-hidden', 'true');
  if (cropper) {
    cropper.destroy();
    cropper = null;
  }
  if (currentFileInput) currentFileInput.value = '';
  currentTargetInput = null;
  currentFileInput = null;
}

cropCancel.addEventListener('click', () => {
  closeCropEditor();
  dialog.showModal();
});

cropConfirm.addEventListener('click', () => {
  if (!cropper || !currentTargetInput) return;

  const canvas = cropper.getCroppedCanvas({
    maxWidth: 800,
    maxHeight: 800,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high'
  });

  currentTargetInput.value = canvas.toDataURL('image/png');

  const preview = currentFileInput?.parentElement?.querySelector('.file-preview');
  if (preview) {
    preview.textContent = '✓ Image cropped and ready (square format)';
    preview.style.color = '#059669';
  }

  closeCropEditor();
  dialog.showModal();
});

async function handleFileSelection(fileInput, targetInput) {
  const [file] = fileInput.files || [];
  if (!file) return;

  try {
    const dataUrl = await readAsDataUrl(file);
    openCropEditor(dataUrl, targetInput, fileInput);
  } catch (_err) {
    alert('Failed to read selected file. Please try another file.');
    fileInput.value = '';
  }
}

brandIconFileInput?.addEventListener('change', () => handleFileSelection(brandIconFileInput, brandIconInput));
faviconFileInput?.addEventListener('change', () => handleFileSelection(faviconFileInput, faviconInput));

function setSaving(isSaving) {
  if (!saveButton) return;
  saveButton.disabled = isSaving;
  saveButton.classList.toggle('is-busy', isSaving);
}

function showSettingsNotice() {
  if (!settingsNotice) return;
  settingsNotice.classList.add('active');
  settingsNotice.setAttribute('aria-hidden', 'false');
}

function hideSettingsNotice() {
  if (!settingsNotice) return;
  settingsNotice.classList.remove('active');
  settingsNotice.setAttribute('aria-hidden', 'true');
}

settingsNoticeOk?.addEventListener('click', () => {
  hideSettingsNotice();
  dialog.close();
  window.location.reload();
});

cancel?.addEventListener('click', () => {
  if (brandIconFileInput) brandIconFileInput.value = '';
  if (faviconFileInput) faviconFileInput.value = '';
  closeCropEditor();
  hideSettingsNotice();
  setSaving(false);
  dialog.close();
});

document.querySelectorAll('.gear').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById('settingsTitle').textContent = 'Site settings: ' + (btn.dataset.displayName || '');
    document.getElementById('site_id').value = btn.dataset.siteId || '';
    document.getElementById('page_title').value = btn.dataset.pageTitle || '';
    document.getElementById('suptitle').value = btn.dataset.suptitle || 'Built with Decap CMS';
    document.getElementById('brand_icon').value = btn.dataset.brandIcon || '';
    document.getElementById('favicon').value = btn.dataset.favicon || '';
    if (brandIconFileInput) brandIconFileInput.value = '';
    if (faviconFileInput) faviconFileInput.value = '';
    document.querySelectorAll('.file-preview').forEach(el => {
      el.textContent = '';
      el.removeAttribute('style');
    });
    hideSettingsNotice();
    setSaving(false);
    dialog.showModal();
  });
});


form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (saveButton?.disabled) return;
  setSaving(true);
  const data = Object.fromEntries(new FormData(form).entries());
  const siteId = data.site_id;
  delete data.site_id;

  try {
    const token = await getUserToken();
    const saveRes = await fetch('/api/sites/' + siteId + '/settings', {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify(data)
    });

    if (!saveRes.ok) {
      const err = await saveRes.json();
      alert('Save failed: ' + (err.error || 'Unknown error'));
      setSaving(false);
      return;
    }

    const result = await saveRes.json();
    
    // Show warnings if any
    if (result.warnings && result.warnings.length > 0) {
      const warningMessage = result.warnings.join('\n\n');
      console.warn('Image size warnings:', result.warnings);
      alert('⚠️  Settings saved with warnings:\n\n' + warningMessage);
    }

    showSettingsNotice();
  } catch (_err) {
    alert('Network error while saving settings.');
    setSaving(false);
  }
});
