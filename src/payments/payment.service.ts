import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from 'src/common/exceptions/app.exception';
import { pendingFeature } from 'src/common/utils/pending-feature.util';
import { isUniqueViolation } from 'src/common/utils/prisma-error.util';
import { CycleService } from 'src/cycles/cycle.service';
import { EnrollmentService } from 'src/enrollments/enrollment.service';
import type { EntryMode, ProgramView } from 'src/programs/program.util';
import { PrismaService } from 'src/prisma/prisma.service';
import type { RecordPaymentDto } from './dto/record-payment.dto';
import type { SetCellDto } from './dto/set-cell.dto';
import { PAYMENT_CELL_SELECT, PAYMENT_ENTRY_SELECT } from './payment.constant';
import type { CellCoordinates, CellPayer, PaymentPayer } from './payment.types';
import {
  cellUniqueKey,
  payerColumns,
  toPaymentCellView,
  toPaymentEntryView,
} from './payment.util';

/**
 * Writes money into a program's books, in the program's entry mode
 * (programEntryMode): monthly cells for PERIODIC programs with cycles, dated
 * entries for everything else. Writes stay inside the program's current
 * cycle when it has one — which is also what fences off the unconfirmed
 * advance-payment flow.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cycleService: CycleService,
    private readonly enrollmentService: EnrollmentService,
  ) {}

  async setCell(
    userId: string,
    programId: string,
    payer: CellPayer,
    { year, month }: CellCoordinates,
    entry: SetCellDto,
  ) {
    await this.assertCellWritable(programId, payer, year);

    // A star stores amount NULL, which CHECK "Payment_amount_matches_star"
    // also enforces — that NULL is what keeps stars out of every SUM. The
    // DTO's refine guarantees an unstarred cell has its amount; were it ever
    // missing, the CHECK rejects the write.
    const data = {
      isStarred: entry.isStarred,
      amount: entry.isStarred ? null : (entry.amount ?? null),
      recordedById: userId,
    };

    // Upsert on the (program, payer, year, month) unique key: saving the
    // same cell twice — a double-click, a retry — rewrites it instead of
    // adding a row.
    const cell = await this.prisma.payment.upsert({
      where: cellUniqueKey(programId, payer, year, month),
      create: { programId, ...payerColumns(payer), year, month, ...data },
      update: data,
      select: PAYMENT_CELL_SELECT,
    });
    return {
      ...toPaymentCellView(cell),
      successCode: 'PAYMENT_CELL_SAVE_SUCCESS',
    };
  }

  async clearCell(
    programId: string,
    payer: CellPayer,
    { year, month }: CellCoordinates,
  ) {
    await this.assertCellWritable(programId, payer, year);

    // Hard delete: an empty cell *is* the absence of a row, and a tombstone
    // would hold the unique key and block re-entering the month. deleteMany
    // so clearing an already-empty cell succeeds — the grid ends up exactly
    // as the treasurer asked either way.
    await this.prisma.payment.deleteMany({
      where: { programId, ...payerColumns(payer), year, month },
    });
    return { year, month, successCode: 'PAYMENT_CELL_CLEAR_SUCCESS' };
  }

  async recordPayment(
    userId: string,
    programId: string,
    dto: RecordPaymentDto,
  ) {
    const year = dto.paymentDate.getUTCFullYear();
    await this.assertWritable(programId, year, 'DATED', dto.payer);

    try {
      const payment = await this.prisma.payment.create({
        data: {
          programId,
          ...payerColumns(dto.payer),
          amount: dto.amount,
          year,
          paymentDate: dto.paymentDate,
          idempotencyKey: dto.idempotencyKey,
          recordedById: userId,
        },
        select: PAYMENT_ENTRY_SELECT,
      });
      return {
        ...toPaymentEntryView(payment),
        successCode: 'PAYMENT_RECORD_SUCCESS',
      };
    } catch (err) {
      // A dated entry (month NULL) can only collide on idempotencyKey: the
      // cell keys treat its NULL month as distinct.
      if (!isUniqueViolation(err) || !dto.idempotencyKey) throw err;
      return this.replayRecordedPayment(programId, dto.idempotencyKey, err);
    }
  }

  async deletePayment(programId: string, paymentId: string) {
    // Side by side: the entry and the program's window. The entry's year is
    // checked against the window once both are in.
    const [found, window] = await Promise.allSettled([
      // month NULL: monthly cells are cleared through their cell URL, where
      // the payer and month are explicit.
      this.prisma.payment.findFirst({
        where: { id: paymentId, programId, month: null },
        select: { year: true },
      }),
      this.cycleService.resolveWindow(programId),
    ]);
    // An entry in a missing program cannot be found, so its 404 answers first.
    if (found.status === 'rejected') throw found.reason;
    const payment = found.value;
    if (!payment) {
      throw new AppException(
        'PAYMENT_NOT_FOUND',
        { paymentId },
        HttpStatus.NOT_FOUND,
      );
    }
    if (window.status === 'rejected') throw window.reason;
    // The same cycle fence as writing it.
    const { cycle } = window.value;
    if (cycle) this.cycleService.assertYearInCycle(cycle, payment.year);

    // Hard delete, like clearing a cell: a wrong entry is removed so every
    // total drops it at once. An audit trail of corrections is not built yet.
    await this.prisma.payment.deleteMany({
      where: { id: paymentId, programId },
    });
    return { id: paymentId, successCode: 'PAYMENT_DELETE_SUCCESS' };
  }

  // TODO(advance-payments): pending confirmation from the fund. A member
  // paying this year for a future year has to be booked somewhere and later
  // reallocated into that year's cells; how, and whether it counts toward
  // this year's collection ratio, is unconfirmed. Until then writes outside
  // the program's current cycle are refused (CycleService.resolveWindow).
  // Expected shape: an AdvancePayment row (enrollment, paidYear, paidMonth,
  // coversYear, amount) plus a reallocation step that writes the covered
  // year's cells — no change to Payment.
  recordAdvancePayment(
    _programId: string,
    _payer: CellPayer,
    _paidOn: CellCoordinates,
    _coversYear: number,
    _amount: string,
  ): never {
    throw pendingFeature('payment.advance');
  }

  private async assertCellWritable(
    programId: string,
    payer: CellPayer,
    year: number,
  ): Promise<void> {
    await this.assertWritable(programId, year, 'MONTHLY', payer);
  }

  /**
   * The checks in front of every payment write: the program exists, keeps
   * this entry mode and its current cycle holds the year; and the payer is
   * valid there. They read independent rows, so they run side by side — a
   * cell save was waiting on them one after another. Settled rather than
   * Promise.all so the program's error always answers first, as it did when
   * it was checked first: an unknown program reads as PROGRAM_NOT_FOUND, not
   * ENROLLMENT_NOT_FOUND.
   */
  private async assertWritable(
    programId: string,
    year: number,
    mode: EntryMode,
    payer: PaymentPayer,
  ): Promise<void> {
    const [window, payerCheck] = await Promise.allSettled([
      this.cycleService.resolveWindow(programId, year),
      this.assertPayer(programId, payer),
    ]);
    if (window.status === 'rejected') throw window.reason;
    this.assertEntryMode(window.value.program, mode);
    if (payerCheck.status === 'rejected') throw payerCheck.reason;
  }

  private assertEntryMode(program: ProgramView, mode: EntryMode): void {
    if (program.entryMode === mode) return;
    throw new AppException(
      mode === 'MONTHLY' ? 'PROGRAM_NOT_MONTHLY' : 'PROGRAM_NOT_DATED',
      { name: program.name },
      HttpStatus.CONFLICT,
    );
  }

  private async assertPayer(
    programId: string,
    payer: PaymentPayer,
  ): Promise<void> {
    switch (payer.kind) {
      case 'CONTRIBUTOR':
        // Also a database fact (Payment's composite FK); this gives the
        // readable error.
        await this.enrollmentService.assertEnrolled(
          programId,
          payer.contributorId,
        );
        return;
      case 'PROGRAM': {
        // TODO(expenses): a program paying another is an outflow for the
        // payer. Today it is recorded only here, as revenue of the receiving
        // program — and never summed into the payer's revenue or collection
        // ratio, since every total filters on programId. Once the Expenses
        // module exists, this same transaction must also be booked as an
        // expense of payer.programId, linked to the Payment row, so the
        // payer's books balance.
        if (payer.programId === programId) {
          throw new AppException('PAYMENT_SELF_TRANSFER');
        }
        // findFirst: a deleted program cannot start paying anyone.
        const payerProgram = await this.prisma.program.findFirst({
          where: { id: payer.programId },
          select: { id: true },
        });
        if (!payerProgram) {
          throw new AppException(
            'PAYMENT_PAYER_PROGRAM_NOT_FOUND',
            { programId: payer.programId },
            HttpStatus.NOT_FOUND,
          );
        }
        return;
      }
      case 'FREETEXT':
        // Nothing to look up: this payer is, by definition, not in the system.
        return;
    }
  }

  // The same key arriving twice is a double submit: answer with the payment
  // the first one booked. The key reused for another program is a client bug
  // and must not silently point at someone else's books.
  private async replayRecordedPayment(
    programId: string,
    idempotencyKey: string,
    originalError: unknown,
  ) {
    const existing = await this.prisma.payment.findUnique({
      where: { idempotencyKey },
      select: { ...PAYMENT_ENTRY_SELECT, programId: true },
    });
    // Gone between the clash and this read; report the clash as it was.
    if (!existing) throw originalError;
    if (existing.programId !== programId) {
      throw new AppException(
        'PAYMENT_IDEMPOTENCY_KEY_REUSED',
        {},
        HttpStatus.CONFLICT,
      );
    }
    return {
      ...toPaymentEntryView(existing),
      successCode: 'PAYMENT_RECORD_SUCCESS',
    };
  }
}
