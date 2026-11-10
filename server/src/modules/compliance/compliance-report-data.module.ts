import { Module } from '@nestjs/common';
import { REPORT_DATA } from './contracts/report-data.js';
import { PostgresReportData } from './infrastructure/report-data.js';
@Module({
  providers: [{ provide: REPORT_DATA, useFactory: () => new PostgresReportData() }],
  exports: [REPORT_DATA],
})
export class ReportDataModule {}
