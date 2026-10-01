import { readCookie } from '../cookie.util';

describe('readCookie', () => {
  it('finds one cookie among several, decoded', () => {
    expect(
      readCookie(
        'theme=dark; sanadoq_refresh=a%2Eb%2Ec; other=1',
        'sanadoq_refresh',
      ),
    ).toBe('a.b.c');
  });

  it('does not match a cookie whose name merely ends with the wanted one', () => {
    expect(
      readCookie('x_sanadoq_refresh=evil', 'sanadoq_refresh'),
    ).toBeUndefined();
  });

  it('treats a malformed escape as absent rather than throwing', () => {
    expect(
      readCookie('sanadoq_refresh=%E0%A4%A', 'sanadoq_refresh'),
    ).toBeUndefined();
  });

  it('is undefined with no Cookie header', () => {
    expect(readCookie(undefined, 'sanadoq_refresh')).toBeUndefined();
  });
});
