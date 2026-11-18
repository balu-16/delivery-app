import {
  Body,
  Controller,
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
  ApiExtraModels,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
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
class EventsQuery {
  @ApiPropertyOptional({ maxLength: 18, description: 'Last received event sequence' })
  @IsOptional()
  @IsString()
  @MaxLength(18)
  after?: string;
}
class AgentRunDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) threadId!: string;
  @ApiProperty({ enum: ['queued', 'running', 'completed', 'waiting', 'failed', 'cancelled'] })
  state!: string;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) clientMessageId!: string | null;
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
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() clientActionId?: string;
  @ApiProperty({ enum: ['approve', 'reject'] }) @IsIn(['approve', 'reject']) decision!:
    'approve' | 'reject';
  @ApiPropertyOptional({ enum: ['en', 'hi', 'te'] })
  @IsOptional()
  @IsIn(['en', 'hi', 'te'])
  locale?: AgentLocale;
}
class ActionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() cardId!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() clientActionId?: string;
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
@ApiExtraModels(AgentRunDto)
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

  @Get('threads')
  @ApiOperation({ operationId: 'customerAgentThreads' })
  listThreads(@CurrentPrincipal() principal: Principal, @Query() query: HistoryQuery) {
    return this.agent.listThreads(principal.userId, query.cursor);
  }

  @Post('threads')
  @ApiOperation({ operationId: 'customerAgentNewThread' })
  create(@CurrentPrincipal() principal: Principal, @Body() body: LocaleQuery) {
    return this.agent.create(principal.userId, body.locale);
  }

  @Get('threads/:threadId')
  @ApiOperation({ operationId: 'customerAgentThread' })
  thread(
    @CurrentPrincipal() principal: Principal,
    @Param('threadId', ParseUUIDPipe) threadId: string,
  ) {
    return this.agent.thread(principal.userId, threadId);
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
          clientActionId: body.clientActionId,
          locale: body.locale ?? 'en',
          signal,
        },
        emit,
      ),
    );
  }

  @Get('threads/:threadId/runs/current')
  @ApiOperation({ operationId: 'customerAgentCurrentRun' })
  @ApiResponse({
    status: 200,
    schema: { allOf: [{ $ref: getSchemaPath(AgentRunDto) }], nullable: true },
  })
  currentRun(
    @CurrentPrincipal() principal: Principal,
    @Param('threadId', ParseUUIDPipe) threadId: string,
  ) {
    return this.agent.currentRun(principal.userId, threadId);
  }

  @Get('threads/:threadId/runs/:runId/events')
  @ApiOperation({ operationId: 'customerAgentRunEvents' })
  async runEvents(
    @CurrentPrincipal() principal: Principal,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query() query: EventsQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.agent.assertAllowed(principal.userId, threadId);
    await this.respond(request, reply, (signal, emit) =>
      this.agent.followRun(principal.userId, threadId, runId, query.after, signal, emit),
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
        if (!reply.raw.destroyed) {
          const sequence = (event as AgentEvent & { sequence?: string }).sequence;
          reply.raw.write(
            `${sequence ? `id: ${sequence}\n` : ''}event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
          );
        }
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
        [
          'RUN_IN_PROGRESS',
          'AGENT_DAILY_LIMIT',
          'DRAFT_PENDING',
          'INVALID_INPUT',
          'AGENT_WORKER_UNAVAILABLE',
        ].includes(error.message)
          ? error.message
          : 'AGENT_UNAVAILABLE';
      emit({
        event: 'run.error',
        data: {
          code,
          retryable: code === 'AGENT_UNAVAILABLE' || code === 'AGENT_WORKER_UNAVAILABLE',
        },
      });
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

  @Post('threads/:threadId/actions')
  @HttpCode(200)
  @ApiOperation({ operationId: 'customerAgentCardAction' })
  action(
    @CurrentPrincipal() principal: Principal,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() body: ActionDto,
  ) {
    return this.agent.action(
      principal.userId,
      threadId,
      body.cardId,
      body.action,
      body.payload,
      body.clientActionId,
    );
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
