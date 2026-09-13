// Check the app's state, not ancestor visibility: Hub can hide a busy iframe.
function setupOperationFinished() {
  const activity = document.querySelector('#activity');
  const result = document.querySelector('#result');
  return Boolean(activity?.classList.contains('hidden') && result &&
    !result.classList.contains('hidden') && result.textContent.trim());
}

module.exports = { setupOperationFinished };
