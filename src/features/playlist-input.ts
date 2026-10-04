/** Client-side validation for playlist create/edit (mirrors YouTube's limits). */
export function validatePlaylistInput(i: { title: string; description: string }): string | null {
  if (!i.title.trim()) return 'Name is required.';
  if (i.title.trim().length > 150) return 'Name must be 150 characters or fewer.';
  if (i.description.length > 5000) return 'Description must be 5,000 characters or fewer.';
  if (/[<>]/.test(i.title)) return 'Name can’t contain < or >.';
  return null;
}
