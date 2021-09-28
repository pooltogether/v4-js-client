import { Provider } from '@ethersproject/abstract-provider'
import { PrizePool } from './PrizePool'
import { Contract, ContractList } from '@pooltogether/contract-list-schema'
import { ContractType } from './constants'
import { contract as etherplexContract, batch, Context } from '@pooltogether/etherplex'
import { Providers } from './types'
import { BaseProvider } from '@ethersproject/providers'
import ERC20Abi from './abis/ERC20Abi'
import { extendContractWithChildren } from './utils/extendContractWithChildren'
import { getContractsByType } from './utils/getContractsByType'
import { sortContractsByContractTypeAndChildren } from './utils/sortContractsByContractTypeAndChildren'
import { sortContractsByChainId } from './utils/sortContractsByChainId'

interface PrizePoolAddresses {
  [prizePoolAddress: string]: {
    token: string
    ticket: string
  }
}

interface PrizePoolAddressesByChainId {
  [chainId: number]: PrizePoolAddresses
}

/**
 * A Linked Prize Pool (a group of Prize Pools).
 * Provides read only functions for getting data needed to display to users.
 * Initializes several PrizePools.
 *
 * NOTE: Initialization is still up in the air since the way we're using
 * contract lists to store Linked Prize Pool data is constantly changing.
 */
export class LinkedPrizePool {
  readonly providers: Providers
  readonly prizePools: PrizePool[]
  readonly contractList: ContractList

  /**
   *
   * @constructor
   * @param providers
   * @param linkedPrizePoolContractList
   */
  constructor(providers: Providers, linkedPrizePoolContractList: ContractList) {
    this.providers = providers
    this.contractList = linkedPrizePoolContractList
    this.prizePools = createPrizePools(providers, linkedPrizePoolContractList.contracts)
  }

  //////////////////////////// Ethers read functions ////////////////////////////

  /**
   * Fetch the users balances for all relevant tokens for all Prize Pools in the Linked Prize Pool.
   * @param usersAddress address to get balances for
   * @returns an array of objects containing the chain id & Prize Pool address and a balances object
   * with the users balances for relevant tokens to the prize pool
   */
  async getUsersPrizePoolBalances(usersAddress: string) {
    const balancesPromises = this.prizePools.map(async (prizePool) => {
      const balances = await prizePool.getUsersPrizePoolBalances(usersAddress)
      return {
        chainId: prizePool.chainId,
        address: prizePool.address,
        balances
      }
    })
    return Promise.all(balancesPromises)
  }
}

/**
 * Utility function to create several Prize Pools from a contract list.
 * NOTE: Requires Prize Pool contracts to be extended with "children".
 * @param providers
 * @param contracts
 * @returns
 */
function createPrizePools(providers: Providers, contracts: Contract[]): PrizePool[] {
  const prizePoolContractLists = sortContractsByContractTypeAndChildren(
    contracts,
    ContractType.YieldSourcePrizePool
  )
  return prizePoolContractLists.map((contracts) => {
    const prizePoolContract = contracts.find(
      (contract) => contract.type === ContractType.YieldSourcePrizePool
    ) as Contract
    const provider = providers[prizePoolContract.chainId]
    return new PrizePool(provider, contracts)
  })
}

//////////////////////////// PROBABLY TEMPORARY PRIZE POOL INITIALIZATION ////////////////////////////

/**
 * - Fetches contract addresses on chain for the provided Prize Pool contracts
 * and extends the Prize Pool contracts with "children".
 * - Injects a contract for the underlying ERC20 of a Prize Pool.
 * Can be bypassed by simply adding "children" extensions into the
 * contract list & including a "Token" contract.
 * @constructor
 * @param providers
 * @param linkedPrizePoolContractList a flat contract list with no extensions
 * @returns
 */
export async function initializeLinkedPrizePool(
  providers: Providers,
  linkedPrizePoolContractList: ContractList
): Promise<LinkedPrizePool | null> {
  const contracts = linkedPrizePoolContractList.contracts
  const prizePoolContracts = getContractsByType(contracts, ContractType.YieldSourcePrizePool)
  const prizePoolContractsByChainId = sortContractsByChainId(prizePoolContracts)
  const chainIds = Object.keys(prizePoolContractsByChainId).map(Number)

  console.log('Init Linked Prize Pool')

  // Fetch relevant child addresses
  const prizePoolAddressBatchRequestPromises = chainIds.map((chainId) =>
    fetchPrizePoolAddressesByChainId(
      chainId,
      providers[chainId],
      prizePoolContractsByChainId[chainId]
    )
  )
  const prizePoolAddressesResponses = await Promise.allSettled(prizePoolAddressBatchRequestPromises)
  console.log(prizePoolAddressesResponses)

  const prizePoolAddresses: {
    chainId: number
    addressesByPrizePool: PrizePoolAddresses
  }[] = []
  prizePoolAddressesResponses.forEach((response) => {
    if (response.status === 'fulfilled') {
      prizePoolAddresses.push(response.value)
    } else {
      console.error('Fetching contract addresses failed with error: ', response.reason)
    }
  })
  const prizePoolAddressesByChainId = {} as PrizePoolAddressesByChainId
  prizePoolAddresses.forEach(
    (ppa) => (prizePoolAddressesByChainId[ppa.chainId] = ppa.addressesByPrizePool)
  )
  console.log(prizePoolAddressesByChainId)

  // Extend the contracts with the child contracts
  const contractsWithChildren = extendContractWithChildren(
    contracts,
    prizePoolAddressesByChainId,
    ContractType.YieldSourcePrizePool
  )

  // Inject a contract for the underlying token
  const contractsWithToken = extendContractsWithToken(contractsWithChildren)
  const updatedContractList = { ...linkedPrizePoolContractList, contracts: contractsWithToken }
  return new LinkedPrizePool(providers, updatedContractList)
}

/**
 * Fetches child contracts for a Prize Pool:
 * - Token (underlying token)
 * - Ticket
 * @param chainId
 * @param provider
 * @param prizePoolContracts
 * @returns
 */
async function fetchPrizePoolAddressesByChainId(
  chainId: number,
  provider: Provider,
  prizePoolContracts: Contract[]
) {
  const batchCalls = [] as Context[]
  prizePoolContracts.forEach((prizePoolContract) => {
    const prizePoolEtherplexContract = etherplexContract(
      prizePoolContract.address,
      prizePoolContract.abi,
      prizePoolContract.address
    )
    // @ts-ignore: Property doesn't exist on MulticallContract
    batchCalls.push(prizePoolEtherplexContract.token().ticket())
  })
  const result = await batch(provider as BaseProvider, ...batchCalls)
  const addressesByPrizePool = {} as PrizePoolAddresses
  Object.keys(result).forEach(
    (prizePoolAddress: any) =>
      (addressesByPrizePool[prizePoolAddress] = {
        token: result[prizePoolAddress].token[0],
        ticket: result[prizePoolAddress].ticket[0]
      })
  )
  return { chainId, addressesByPrizePool }
}

/**
 * Injects a contract for the underlying token into the contract list if there isn't one.
 * @param contracts
 * @returns
 */
function extendContractsWithToken(contracts: Contract[]) {
  const updatedContracts = [...contracts]
  const tokens: { address: string; chainId: number }[] = contracts
    .filter((contract) => {
      return Boolean(contract.extensions?.children)
    })
    .flatMap((contract) => contract.extensions?.children)
  tokens.forEach((token) => {
    const tokenContract = contracts.find(
      (contract) => contract.address === token.address && contract.chainId === token.chainId
    )
    if (!tokenContract) {
      updatedContracts.push(createTokenContract(token.chainId, token.address))
    }
  })
  return updatedContracts
}

function createTokenContract(chainId: number, address: string) {
  return {
    chainId,
    address,
    version: {
      major: 1,
      minor: 0,
      patch: 0
    },
    type: 'Token',
    abi: ERC20Abi,
    tags: [],
    extensions: {}
  } as Contract
}
