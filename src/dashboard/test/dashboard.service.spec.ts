import type { EradatSummaryService } from '../../eradat/eradat-summary.service';
import type { ExpenseSummaryService } from '../../expenses/expense-summary.service';
import type { ProgramWindowService } from '../../programs/program-window.service';
import { DashboardService } from '../dashboard.service';

const WINDOW = {
  program: { id: 'mwa', name: 'مواساة', entryMode: 'MONTHLY' },
  year: 2026,
  years: [2025, 2026],
};

const months = (totals: string[]) =>
  totals.map((total, index) => ({ month: index + 1, total }));

describe('DashboardService', () => {
  const mockWindow = { resolve: jest.fn() };
  const mockRevenue = { summarise: jest.fn() };
  const mockExpenses = { summarise: jest.fn() };
  let service: DashboardService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockWindow.resolve.mockResolvedValue(WINDOW);
    mockRevenue.summarise.mockResolvedValue({
      revenue: { total: '395000.00' },
      months: months(['39000.00', ...Array(11).fill('0.00')]),
      yearTotals: [
        { year: 2025, total: '0.00' },
        { year: 2026, total: '395000.00' },
      ],
    });
    mockExpenses.summarise.mockResolvedValue({
      total: '361000.00',
      months: months(['48000.00', ...Array(11).fill('0.00')]),
      yearTotals: [
        { year: 2025, total: '576000.00' },
        { year: 2026, total: '361000.00' },
      ],
    });
    service = new DashboardService(
      mockWindow as unknown as ProgramWindowService,
      mockRevenue as unknown as EradatSummaryService,
      mockExpenses as unknown as ExpenseSummaryService,
    );
  });

  it('resolves one window and hands it to both sides, so they are about the same year', async () => {
    await service.getDashboard('mwa', { year: 2026 });

    expect(mockWindow.resolve).toHaveBeenCalledTimes(1);
    expect(mockRevenue.summarise).toHaveBeenCalledWith(WINDOW);
    expect(mockExpenses.summarise).toHaveBeenCalledWith(WINDOW);
  });

  it('balances each year, month and the year on screen as revenue less expenses — negative when more went out', async () => {
    const { balance } = await service.getDashboard('mwa', { year: 2026 });

    expect(balance).toMatchObject({
      revenue: '395000.00',
      expenses: '361000.00',
      balance: '34000.00',
    });
    expect(balance.months[0]).toEqual({
      month: 1,
      revenue: '39000.00',
      expenses: '48000.00',
      balance: '-9000.00',
    });
    expect(balance.years).toEqual([
      {
        year: 2025,
        revenue: '0.00',
        expenses: '576000.00',
        balance: '-576000.00',
      },
      {
        year: 2026,
        revenue: '395000.00',
        expenses: '361000.00',
        balance: '34000.00',
      },
    ]);
  });
});
