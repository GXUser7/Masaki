// Фон тестового расширения: бейдж на кнопке и пункт в контекстном меню страницы.
chrome.action.setBadgeText({ text: '3' })
chrome.action.setBadgeBackgroundColor({ color: '#d93025' })
chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({ id: 'masaki-test', title: 'Проверить в Masaki', contexts: ['page'] })
})
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'masaki-test') chrome.action.setBadgeText({ text: 'ok' })
})
