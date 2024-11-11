import {
  EvaluationConfigurationBoolean,
  EvaluationConfigurationNumerical,
  EvaluationConfigurationText,
  EvaluationDto,
  EvaluationMetadataLlmAsJudgeAdvanced,
  EvaluationMetadataLlmAsJudgeSimple,
  EvaluationMetadataType,
  EvaluationResultableType,
  findFirstModelForProvider,
  IEvaluationConfiguration,
  IEvaluationMetadata,
  User,
  Workspace,
} from '../../browser'
import { database } from '../../client'
import { findEvaluationTemplateById } from '../../data-access'
import { publisher } from '../../events/publisher'
import {
  BadRequestError,
  NotFoundError,
  PromisedResult,
  Result,
  Transaction,
} from '../../lib'
import {
  evaluationConfigurationBoolean,
  evaluationConfigurationNumerical,
  evaluationConfigurationText,
  evaluationMetadataLlmAsJudgeAdvanced,
  evaluationMetadataLlmAsJudgeSimple,
  evaluations,
} from '../../schema'
import { findDefaultProvider } from '../providerApiKeys/findDefaultProvider'
import { connectEvaluations } from './connect'

type EvaluationResultConfigurationNumerical = {
  minValue: number
  maxValue: number
} & Partial<
  Omit<EvaluationConfigurationNumerical, 'id' | 'minValue' | 'maxValue'>
>

type EvaluationResultConfigurationText = Partial<
  Omit<EvaluationConfigurationText, 'id'>
>

type EvaluationResultConfigurationBoolean = Partial<
  Omit<EvaluationConfigurationBoolean, 'id'>
>

export async function createEvaluation<
  M extends EvaluationMetadataType,
  R extends EvaluationResultableType,
>(
  {
    workspace,
    user,
    name,
    description,
    metadataType,
    metadata,
    resultType,
    resultConfiguration,
    projectId,
    documentUuid,
  }: {
    workspace: Workspace
    user: User
    name: string
    description: string
    metadataType: M
    metadata: M extends EvaluationMetadataType.LlmAsJudgeSimple
      ? Omit<EvaluationMetadataLlmAsJudgeSimple, 'id'>
      : M extends EvaluationMetadataType.LlmAsJudgeAdvanced
        ? { prompt: string } & Partial<
            Omit<
              EvaluationMetadataLlmAsJudgeAdvanced,
              'id' | 'configuration' | 'prompt'
            >
          >
        : never
    resultType: R
    resultConfiguration: R extends EvaluationResultableType.Boolean
      ? EvaluationResultConfigurationBoolean
      : R extends EvaluationResultableType.Number
        ? EvaluationResultConfigurationNumerical
        : R extends EvaluationResultableType.Text
          ? EvaluationResultConfigurationText
          : never
    projectId?: number
    documentUuid?: string
  },
  db = database,
): PromisedResult<EvaluationDto> {
  const validConfig = validateResultConfiguration({
    resultType,
    resultConfiguration,
  })
  if (validConfig.error) return validConfig

  const metadataTables = {
    [EvaluationMetadataType.LlmAsJudgeAdvanced]:
      evaluationMetadataLlmAsJudgeAdvanced,
    [EvaluationMetadataType.LlmAsJudgeSimple]:
      evaluationMetadataLlmAsJudgeSimple,
  } as const

  if (!metadataTables[metadataType]) {
    return Result.error(
      new BadRequestError(`Invalid metadata type ${metadataType}`),
    )
  }

  const configurationTables = {
    [EvaluationResultableType.Boolean]: evaluationConfigurationBoolean,
    [EvaluationResultableType.Number]: evaluationConfigurationNumerical,
    [EvaluationResultableType.Text]: evaluationConfigurationText,
  } as const

  if (!configurationTables[resultType]) {
    return Result.error(
      new BadRequestError(`Invalid result type ${resultType}`),
    )
  }

  return await Transaction.call(async (tx) => {
    const metadataRow = (await tx
      .insert(metadataTables[metadataType])
      .values([metadata])
      .returning()
      .then((r) => r[0]!)) as IEvaluationMetadata

    const configurationRow = (await tx
      .insert(configurationTables[resultType])
      .values([resultConfiguration])
      .returning()
      .then((r) => r[0]!)) as IEvaluationConfiguration

    const evaluation = await tx
      .insert(evaluations)
      .values([
        {
          workspaceId: workspace.id,
          name,
          description,
          metadataType,
          metadataId: metadataRow.id,
          resultType,
          resultConfigurationId: configurationRow.id,
        },
      ])
      .returning()
      .then((r) => r[0]!)

    if (projectId && documentUuid) {
      await connectEvaluations(
        {
          workspace,
          documentUuid,
          evaluationUuids: [evaluation.uuid],
          user,
        },
        tx,
      ).then((r) => r.unwrap())
    }

    publisher.publishLater({
      type: 'evaluationCreated',
      data: {
        evaluation,
        workspaceId: workspace.id,
        userEmail: user.email,
        projectId,
        documentUuid,
      },
    })

    const evaluationDto = {
      ...evaluation,
      metadata: metadataRow,
      resultConfiguration: configurationRow,
    } as EvaluationDto

    return Result.ok(evaluationDto)
  }, db)
}

export async function importLlmAsJudgeEvaluation(
  {
    workspace,
    user,
    templateId,
  }: { workspace: Workspace; user: User; templateId: number },
  db = database,
) {
  const templateResult = await findEvaluationTemplateById(templateId, db)
  if (templateResult.error) return templateResult

  const template = templateResult.unwrap()
  const resultConfiguration =
    template.configuration.type === EvaluationResultableType.Number
      ? {
          minValue: template.configuration.detail!.range.from,
          maxValue: template.configuration.detail!.range.to,
        }
      : undefined

  return await createAdvancedEvaluation(
    {
      user,
      workspace,
      name: template.name,
      description: template.description,
      resultType: template.configuration.type,
      resultConfiguration: resultConfiguration ?? {},
      metadata: {
        prompt: template.prompt,
        templateId: template.id,
      },
    },
    db,
  )
}

export async function createAdvancedEvaluation<
  R extends EvaluationResultableType,
>(
  {
    workspace,
    resultType,
    resultConfiguration,
    metadata,
    ...props
  }: {
    workspace: Workspace
    user: User
    name: string
    description: string
    resultType: R
    resultConfiguration: R extends EvaluationResultableType.Boolean
      ? EvaluationResultConfigurationBoolean
      : R extends EvaluationResultableType.Number
        ? EvaluationResultConfigurationNumerical
        : typeof resultType extends EvaluationResultableType.Text
          ? EvaluationResultConfigurationText
          : never
    metadata: { prompt: string; templateId?: number }
    projectId?: number
    documentUuid?: string
  },
  db = database,
): PromisedResult<EvaluationDto> {
  const provider = await findDefaultProvider(workspace, db)
  if (!provider) {
    return Result.error(
      new NotFoundError(
        'In order to create an evaluation you need to first create a provider API key from OpenAI or Anthropic',
      ),
    )
  }

  const promptWithProvider = provider
    ? `---
provider: ${provider.name}
model: ${findFirstModelForProvider(provider.provider)}
---
${metadata.prompt}
`.trim()
    : metadata.prompt

  return createEvaluation(
    {
      workspace,
      ...props,
      metadataType: EvaluationMetadataType.LlmAsJudgeAdvanced,
      metadata: {
        prompt: promptWithProvider,
        configuration: resultConfiguration,
        templateId: metadata.templateId ?? null,
      } as Omit<EvaluationMetadataLlmAsJudgeAdvanced, 'id'>,
      resultType,
      resultConfiguration,
    },
    db,
  )
}

function validateResultConfiguration({
  resultType,
  resultConfiguration,
}: {
  resultType: EvaluationResultableType
  resultConfiguration:
    | EvaluationResultConfigurationNumerical
    | EvaluationResultConfigurationBoolean
    | EvaluationResultConfigurationText
}) {
  if (resultType !== EvaluationResultableType.Number) {
    return Result.ok(resultConfiguration)
  }

  const conf = resultConfiguration as EvaluationResultConfigurationNumerical
  if (conf.minValue >= conf.maxValue) {
    return Result.error(
      new BadRequestError(
        'Invalid range min value has to be less than max value',
      ),
    )
  }

  return Result.ok(resultConfiguration)
}
