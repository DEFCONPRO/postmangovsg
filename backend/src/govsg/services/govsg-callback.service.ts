import config from '@core/config'
import validator from 'validator'
import { loggerWithLabel } from '@core/logger'
import {
  UserMessageWebhook,
  WhatsAppApiClient,
  WhatsAppId,
  WhatsAppLanguages,
  WhatsAppMessageStatus,
  WhatsAppTemplateMessageToSend,
  WhatsAppTemplateMessageWebhook,
  WhatsAppTextMessageToSend,
  WhatsAppWebhookTextMessage,
  WhatsappWebhookMessageType,
} from '@shared/clients/whatsapp-client.class/types'
import { UnexpectedWebhookError } from '@shared/clients/whatsapp-client.class/errors'
import { GovsgMessage, GovsgMessageTransactional } from '@govsg/models'
import { govsgMessageStatusMapper } from '@core/constants'
import { WhatsAppService } from '@core/services'

const logger = loggerWithLabel(module)

const isAuthenticated = (token: string): boolean => {
  const verifyToken = config.get('whatsapp.callbackVerifyToken')
  return token === verifyToken
}

const parseWebhook = async (
  body: unknown,
  clientId: WhatsAppApiClient
): Promise<void> => {
  const action = 'parseWebhook'
  logger.info({
    message: 'Received webhook from WhatsApp',
    action,
  })
  // based on current setup, we expect the shape of body to be either
  // WhatsAppTemplateMessageWebhook or UserMessageWebhook
  // if it's neither, we should thrown an error
  // ideally, should do full validation of the body using sth like Zod
  if (!body || typeof body !== 'object') {
    logger.error({
      message: 'Unexpected webhook body',
      action,
      body,
    })
    throw new UnexpectedWebhookError('Unexpected webhook body')
  }
  if ('statuses' in body) {
    // can delete this after we verified that it all works
    logger.info({
      message: 'Received status webhook from WhatsApp',
      action,
    })
    await parseTemplateMessageWebhook(body as WhatsAppTemplateMessageWebhook)
    return
  }
  if ('messages' in body && 'contacts' in body) {
    // can delete this after we verified that it all works
    logger.info({
      message: 'Received message webhook from WhatsApp',
      action,
    })
    await parseUserMessageWebhook(body as UserMessageWebhook, clientId)
    return
  }
  // body is an object but doesn't have the expected keys
  logger.error({
    message: 'Unexpected webhook body',
    action,
    body,
  })
  throw new UnexpectedWebhookError('Unexpected webhook body')
}

const parseTemplateMessageWebhook = async (
  body: WhatsAppTemplateMessageWebhook
): Promise<void> => {
  const { id: messageId } = body.statuses[0]
  const [govsgMessage, govsgMessageTransactional] = await Promise.all([
    GovsgMessage.findOne({ where: { serviceProviderMessageId: messageId } }),
    GovsgMessageTransactional.findOne({
      where: { serviceProviderMessageId: messageId },
    }),
  ])
  if (!govsgMessage && !govsgMessageTransactional) {
    logger.info({
      message:
        'Received webhook for message not in GovsgMessage or GovsgMessageTransactional',
      meta: {
        messageId,
      },
    })
    // no match found, assume it's a Standard Reply webhook, safe to ignore
    return
  }
  if (govsgMessage && govsgMessageTransactional) {
    // this should basically never happen
    logger.error({
      message: 'Received webhook for message that exists in both tables',
      meta: {
        messageId,
      },
    })
    throw new UnexpectedWebhookError(
      'Received webhook for message that exists in both tables'
    )
  }
  // NB unable to abstract further with type safety because Sequelize doesn't
  // play well with TypeScript. I wanted to use GovsgMessage | GovsgMessageTransactional type
  // but I am unable to access the methods common to both models with type safety
  // hence the following verbose code, you gotta do what you gotta do
  const whatsappStatus = body.statuses[0].status
  const whereOpts = {
    where: {
      serviceProviderMessageId: messageId,
    },
  }
  switch (whatsappStatus) {
    case WhatsAppMessageStatus.warning: {
      logger.warn({
        message: 'Received webhook with warning status',
        meta: {
          messageId,
          body,
        },
      })
      // no corresponding status to update
      // to do with items in catalog (e-commerce use case), not relevant to us
      // https://developers.facebook.com/docs/whatsapp/on-premises/webhooks/outbound/#notification-types
      return
    }
    case WhatsAppMessageStatus.failed: {
      logger.info({
        message: 'Received webhook with error status',
      })
      if (!body.errors || body.errors.length === 0) {
        logger.error({
          message: 'Received webhook with error status but no error details',
          meta: {
            messageId,
            body,
          },
        })
        const fieldOpts = {
          status: govsgMessageStatusMapper(whatsappStatus),
          erroredAt: new Date(),
        }
        void govsgMessage?.update(fieldOpts, whereOpts)
        void govsgMessageTransactional?.update(fieldOpts, whereOpts)
        // not sure whether need to throw an error hmm probably not?
        return
      }
      const { code, title, details, href } = body.errors[0]
      const errorCode = code.toString()
      const errorDescription = `${title} Details: ${details} href: ${href}`
      const fieldOpts = {
        status: govsgMessageStatusMapper(whatsappStatus),
        errorCode,
        errorDescription,
        erroredAt: new Date(),
      }
      void govsgMessage?.update(fieldOpts, whereOpts)
      void govsgMessageTransactional?.update(fieldOpts, whereOpts)
      return
    }
    case WhatsAppMessageStatus.sent: {
      const fieldOpts = {
        status: govsgMessageStatusMapper(whatsappStatus),
        sentAt: new Date(),
      }
      void govsgMessage?.update(fieldOpts, whereOpts)
      void govsgMessageTransactional?.update(fieldOpts, whereOpts)
      return
    }
    case WhatsAppMessageStatus.delivered: {
      const fieldOpts = {
        status: govsgMessageStatusMapper(whatsappStatus),
        deliveredAt: new Date(),
      }
      void govsgMessage?.update(fieldOpts, whereOpts)
      void govsgMessageTransactional?.update(fieldOpts, whereOpts)
      return
    }
    case WhatsAppMessageStatus.read: {
      const fieldOpts = {
        status: govsgMessageStatusMapper(whatsappStatus),
        readAt: new Date(),
      }
      void govsgMessage?.update(fieldOpts, whereOpts)
      void govsgMessageTransactional?.update(fieldOpts, whereOpts)
      return
    }
    case WhatsAppMessageStatus.deleted: {
      const fieldOpts = {
        status: govsgMessageStatusMapper(whatsappStatus),
        deletedAt: new Date(),
      }
      void govsgMessage?.update(fieldOpts, whereOpts)
      void govsgMessageTransactional?.update(fieldOpts, whereOpts)
      return
    }
    default: {
      const exhaustiveCheck: never = whatsappStatus
      throw new Error(`Unhandled status: ${exhaustiveCheck}`)
    }
  }
}

const parseUserMessageWebhook = async (
  body: UserMessageWebhook,
  clientId: WhatsAppApiClient
): Promise<void> => {
  const { wa_id: whatsappId } = body.contacts[0]
  const { id: messageId, type } = body.messages[0]
  if (type !== WhatsappWebhookMessageType.text) {
    // not text message, log and ignore
    logger.info({
      message: 'Received webhook for non-text message',
      meta: {
        whatsappId,
        messageId,
        type,
      },
    })
    return
  }
  const message = body.messages[0] as WhatsAppWebhookTextMessage
  const { body: rawMessageBody } = message.text
  const sanitisedMessageBody = validator.blacklist(
    rawMessageBody,
    '\\/\\\\[\\]<>()*'
  )
  const autoReplyNeeded = shouldSendAutoReply(sanitisedMessageBody)
  if (!autoReplyNeeded) return
  logger.info({
    message: 'Sending auto reply',
    meta: {
      whatsappId,
      messageId,
      messageBody: sanitisedMessageBody,
    },
  })
  await sendAutoReply(whatsappId, clientId)
}

const shouldSendAutoReply = (messageBody: string): boolean => {
  if (messageBody.length > 256 || messageBody.length === 0) {
    return false
  }
  const matchedRegex = matchAnyRegex(messageBody.toLowerCase(), [
    new RegExp(/auto.reply/i),
    new RegExp(/thank/i),
    new RegExp(/received your message/i),
    new RegExp(/http/i),
    new RegExp(/out.of.office/i),
    new RegExp(/dear customer*/i),
  ])
  if (matchedRegex) return false
  return true
}

function matchAnyRegex(input: string, validations: Array<RegExp>): boolean {
  try {
    for (let index = 0; index < validations.length; index++) {
      const validation = validations[index]
      if (validation.test(input)) {
        return true
      }
    }
    return false
  } catch (error) {
    logger.error({ errorTitle: 'Error validating user input', error })
    // default to returning true, so that auto-reply will not be sent
    return true
  }
}

async function sendAutoReply(
  whatsappId: WhatsAppId,
  clientId: WhatsAppApiClient
): Promise<void> {
  const isLocal = config.get('env') === 'development'
  if (isLocal) {
    const templateMessageToSend: WhatsAppTemplateMessageToSend = {
      recipient: whatsappId,
      apiClient: clientId,
      templateName: '2019covid19_ack',
      params: [],
      language: WhatsAppLanguages.english,
    }
    await WhatsAppService.whatsappClient.sendTemplateMessage(
      templateMessageToSend,
      isLocal
    )
    return
  }
  const textMessageToSend: WhatsAppTextMessageToSend = {
    recipient: whatsappId,
    apiClient: clientId,
    body: 'If you are inquiring about COVID-19 updates, the COVID-19 infobot is temporarily unavailable due to maintenance work. For more COVID-19 related information, please visit the Ministry of Health’s website at moh.gov.sg. Thank you',
  }
  // can substitute this with template message if we get such a template approved
  await WhatsAppService.whatsappClient.sendTextMessage(textMessageToSend)
}

export const GovsgCallbackService = { isAuthenticated, parseWebhook }