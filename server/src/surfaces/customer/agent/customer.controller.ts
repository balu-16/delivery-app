import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
} from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  AGENT_OPERATIONS,
  type AgentEvent,
  type AgentLocale,
  type AgentOperations,
} from '../../../modules/agent/contracts/agent.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';

class LocaleQuery {
  @ApiPropertyOptional({ enum: ['en', 'hi', 'te'] })
  @IsOptional()
  @IsIn(['en', 'hi', 'te'])
  locale?: AgentLocale;
}
class HistoryQuery {
  @ApiPropertyOptional({ maxLength: 256 })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;
}
class FeedbackDto {
  @ApiProperty({ enum: ['up', 'down'] }) @IsIn(['up', 'down']) rating!: 'up' | 'down';
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
class MessageDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() clientMessageId!: string;
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;
  @ApiPropertyOptional({ enum: ['en', 'hi', 'te'] })
  @IsOptional()
  @IsIn(['en', 'hi', 'te'])
  locale?: AgentLocale;
}
class ResumeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() draftId!: string;
  @ApiProperty({ enum: ['approve', 'reject'] }) @IsIn(['approve', 'reject']) decision!:
    'approve' | 'reject';
  @ApiPropertyOptional({ enum: ['en', 'hi', 'te'] })
  @IsOptional()
  @IsIn(['en', 'hi', 'te'])
  locale?: AgentLocale;
}
class ActionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() cardId!: string;
  @ApiProperty({ enum: ['add_to_cart'] }) @IsIn(['add_to_cart']) action!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) @IsObject() payload!: Record<
    string,
    unknown
  >;
}
class AgentConfigDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: [String] }) suggestedPrompts!: string[];
  @ApiProperty() maxMessageChars!: number;
  @ApiProperty() disclosureVersion!: string;
  @ApiProperty({ isArray: true, enum: ['en', 'hi', 'te'] }) supportedLocales!: AgentLocale[];
}

@Controller('v1/customer/agent')
@ApiBearerAuth()
@AuthPolicy({ audience: 'customer' })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class CustomerAgentController {
  constructor(@Inject(AGENT_OPERATIONS) private readonly agent: AgentOperations) {}

  @Get('config')
  @ApiOperation({ operationId: 'customerAgentConfig' })
  @ApiResponse({ status: 200, type: AgentConfigDto })
  config(@Query() query: LocaleQuery) {
    return this.agent.config(query.locale);
  }

  @Get('threads/current')
  @ApiOperation({ operationId: 'customerAgentCurrentThread' })
  current(@CurrentPrincipal() principal: Principal, @Query() query: LocaleQuery) {
    return this.agent.current(principal.userId, query.locale);
  }

  @Post('threads')
  @ApiOperation({ operationId: 'customerAgentNewThread' })
  create(@CurrentPrincipal() principal: Principal, @Body() body: LocaleQuery) {
    return this.agent.create(principal.userId, body.locale);
  }

  @Get('threads/:threadId/messages')
  @ApiOperation({ operationId: 'customerAgentHistory' })
  messages(
    @CurrentPrincipal() principal: Principal,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Query() query: HistoryQuery,
  ) {
    return this.agent.messages(principal.userId, threadId, query.cursor);
  }

  @Post('threads/:threadId/messages')
  @HttpCode(200)
  @ApiOperation({ operationId: 'customerAgentSendMessage' })
  async send(
    @CurrentPrincipal() principal: Principal,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() body: MessageDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.agent.assertAllowed(principal.userId, threadId);
    await this.respond(request, reply, (signal, emit) =>
      this.agent.run(
        {
          userId: principal.userId,
          threadId,
          clientMessageId: body.clientMessageId,
          text: body.text,
          locale: body.locale ?? 'en',
          signal,
        },
        emit,
      ),
    );
  }

  @Post('threads/:threadId/resume')
  @HttpCode(200)
  @ApiOperation({ operationId: 'customerAgentResume' })
  async resume(
    @CurrentPrincipal() principal: Principal,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() body: ResumeDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.agent.assertAllowed(principal.userId, threadId);
    await this.respond(request, reply, (signal, emit) =>
      this.agent.resume(
        {
          userId: principal.userId,
          threadId,
          draftId: body.draftId,
          decision: body.decision,
          locale: body.locale ?? 'en',
          signal,
        },
        emit,
      ),
    );
  }

  private async respond(
    request: FastifyRequest,
    reply: FastifyReply,
    work: (signal: AbortSignal, emit: (event: AgentEvent) => void) => Promise<void>,
  ): Promise<void> {
    const abort = new AbortController();
    const streaming = (request.headers.accept ?? '').includes('text/event-stream');
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent) => {
      if (streaming) {
        if (!reply.raw.destroyed)
          reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
      } else events.push(event);
    };
    let heartbeat: NodeJS.Timeout | undefined;
    if (streaming) {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      reply.raw.on('close', () => abort.abort());
      heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
      }, 15000);
      heartbeat.unref();
    }
    try {
      await work(abort.signal, emit);
      if (!streaming) reply.status(200).send({ events });
    } catch (error: unknown) {
      if (!streaming) throw error;
      const code =
        error instanceof Error &&
        ['RUN_IN_PROGRESS', 'AGENT_DAILY_LIMIT', 'DRAFT_PENDING', 'INVALID_INPUT'].includes(
          error.message,
        )
          ? error.message
          : 'AGENT_UNAVAILABLE';
      emit({ event: 'run.error', data: { code, retryable: code === 'AGENT_UNAVAILABLE' } });
      emit({ event: 'run.ended', data: {} });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (streaming && !reply.raw.destroyed) reply.raw.end();
    }
  }

  @Post('threads/:threadId/cancel')
  @HttpCode(200)
  @ApiOperation({ operationId: 'customerAgentCancelRun' })
  cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('threadId', ParseUUIDPipe) threadId: string,
  ) {
    return this.agent.cancel(principal.userId, threadId);
  }

  @Delete('threads')
  @HttpCode(204)
  @ApiOperation({ operationId: 'customerAgentDeleteAllThreads' })
  deleteAllThreads(@CurrentPrincipal() principal: Principal) {
    return this.agent.deleteAllThreads(principal.userId);
  }

  @Delete('threads/:threadId')
  @ApiOperation({ operationId: 'customerAgentDeleteThread' })
  deleteThread(
    @CurrentPrincipal() principal: Principal,
    @Param('threadId', ParseUUIDPipe) threadId: string,
  ) {
    return this.agent.deleteThread(principal.userId, threadId);
  }

  @Post('threads/:threadId/actions')
  @HttpCode(200)
  @ApiOperation({ operationId: 'customerAgentCardAction' })
  action(
    @CurrentPrincipal() principal: Principal,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() body: ActionDto,
  ) {
    return this.agent.action(principal.userId, threadId, body.cardId, body.action, body.payload);
  }

  @Post('messages/:messageId/feedback')
  @ApiOperation({ operationId: 'customerAgentFeedback' })
  feedback(
    @CurrentPrincipal() principal: Principal,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() body: FeedbackDto,
  ) {
    return this.agent.feedback(principal.userId, messageId, body.rating, body.reason);
  }
}
