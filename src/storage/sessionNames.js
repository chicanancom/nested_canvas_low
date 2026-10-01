/** Choose a readable name that remains distinct in case-insensitive search. */
export function uniqueSessionName(name, sessions) {
  const base = name.trim() || 'Bảng mới';
  const key = value => value.trim().normalize('NFC').toLocaleLowerCase('vi');
  const used = new Set(sessions.map(session => key(session.name || '')));
  if (!used.has(key(base))) return base;
  let number = 2;
  while (used.has(key(`${base} (${number})`))) number++;
  return `${base} (${number})`;
}
