/**
 * Whose row a monthly cell sits on: an enrolled contributor's, or another
 * program's (a program paying this one out of its own funds). A stranger has
 * no row in a grid — CHECK "Payment_freetext_is_dated" — so there is no
 * free-text cell payer.
 */
export type CellPayer =
  | { kind: 'CONTRIBUTOR'; contributorId: string }
  | { kind: 'PROGRAM'; programId: string };

/** Who made a payment — exactly one of these, as CHECK "Payment_exactly_one_payer" demands. */
export type PaymentPayer = CellPayer | { kind: 'FREETEXT'; name: string };

export interface CellCoordinates {
  year: number;
  month: number;
}
