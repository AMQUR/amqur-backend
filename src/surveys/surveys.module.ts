import { Module } from '@nestjs/common';
import { CustomerSurveyService } from './customer-survey.service';
import { SurveysController } from './surveys.controller';

@Module({
  controllers: [SurveysController],
  providers: [CustomerSurveyService],
  exports: [CustomerSurveyService],
})
export class SurveysModule {}
