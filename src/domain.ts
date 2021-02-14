import log from './helpers/logger'
import startSpinner from './helpers/loader'
import { sleep } from './helpers/util'
import { prompt, validateDomainOrSubdomain } from './helpers/prompt'
import { getStoredContactDetails, storeContactDetails } from './helpers/storage'
import Route53Domains from 'aws-sdk/clients/route53domains'
import Route53 from 'aws-sdk/clients/route53'

const registerDomain = async (options: Options): Promise<DomainResult> => {
  log.log('Requesting TLS certificate from ACM')

  const region = await prompt({
    message: 'Which AWS region?',
    initial: 'us-east-1',
  })

  const route53 = new Route53({ apiVersion: '2013-04-01', region })
  const route53domains = new Route53Domains({
    apiVersion: '2014-05-15',
    region,
  })

  let { domain } = options

  if (!domain) {
    domain = (await prompt({
      message: 'What domain would you like to register?',
      validate: validateDomainOrSubdomain,
    })) as string
  }

  const {
    Availability: availability,
  } = await route53domains
    .checkDomainAvailability({ DomainName: domain })
    .promise()

  if (availability !== 'AVAILABLE') {
    log.error(`Domain ${domain} is not available! Status = ${availability}`)
    process.exit(1)
  }

  const existingContactDetail = getStoredContactDetails()

  let shouldUseExistingContactDetails = false
  if (existingContactDetail) {
    log.debug('Existing contact details:')
    log.debug(existingContactDetail)

    shouldUseExistingContactDetails = await prompt({
      type: 'confirm',
      message: 'Existing contact details detected. Use those?',
      initial: true,
    })
  }

  let contactDetails: Route53Domains.ContactDetail = {}
  if (shouldUseExistingContactDetails) {
    contactDetails = existingContactDetail as Route53Domains.ContactDetail
  } else {
    log.log("We'll need some contact info then.\n")

    contactDetails.FirstName = await prompt({ message: 'First name' })
    contactDetails.LastName = await prompt({ message: 'Last name' })
    contactDetails.AddressLine1 = await prompt({ message: 'Address line 1' })
    contactDetails.AddressLine2 = await prompt({ message: 'Address line 2' })
    contactDetails.City = await prompt({ message: 'City' })
    contactDetails.State = await prompt({ message: 'State' })
    contactDetails.CountryCode = await prompt({
      message: 'Country Code',
      initial: 'US',
    })
    contactDetails.ZipCode = await prompt({ message: 'Zipcode' })
    contactDetails.Email = await prompt({ message: 'Email' })
    contactDetails.PhoneNumber = await prompt({
      message: 'Phone number (must be in the form +1.1234567890)',
    })
    contactDetails.ContactType = 'PERSON'

    log.log("Great! We'll save those for next time.\n")
    storeContactDetails(contactDetails)
  }

  log.log(
    '\nWarning! Proceeding will cause charges to your AWS account. See https://d32ze2gidvkk54.cloudfront.net/Amazon_Route_53_Domain_Registration_Pricing_20140731.pdf for Domain Registration pricing by TLD.',
  )
  const shouldProceed = await prompt({
    type: 'confirm',
    message: 'Proceed?',
  })
  if (!shouldProceed) {
    process.exit()
  }

  const domainRequestOptions = {
    DomainName: domain,
    DurationInYears: 1,
    AutoRenew: true,
    AdminContact: contactDetails,
    RegistrantContact: contactDetails,
    TechContact: contactDetails,
    PrivacyProtectAdminContact: true,
    PrivacyProtectRegistrantContact: true,
    PrivacyProtectTechContact: true,
  }
  const { OperationId: operationId } = await route53domains
    .registerDomain(domainRequestOptions)
    .promise()

  log.info(`Route53 operationId: ${operationId}`)

  const spinner = startSpinner(
    'Waiting for domain registration request to complete. Note: this can take ~15 minutes.',
  )

  while (true) {
    const { Status: status } = await route53domains
      .getOperationDetail({ OperationId: operationId })
      .promise()

    if (status === 'SUCCESSFUL') {
      break
    } else if (status === 'ERROR' || status === 'FAILED') {
      log.error(`Domain registration did not succeed. Status: ${status}.`)
      process.exit(1)
    }

    sleep(10 * 1000)
  }

  spinner.stop()
  log.log('Domain registration complete!')

  const hostedZones = await route53.listHostedZones().promise()
  const hostedZone = hostedZones.HostedZones.find(
    ({ Name: name }) => name === domain,
  )
  if (!hostedZone) {
    log.error('Unable to retrieve hosted zone for newly registered domain.')
    process.exit(1)
  }
  const hostedZoneId = hostedZone.Id
  log.info(`Domain registered. Hosted zone id: ${hostedZoneId}`)

  return { domain, hostedZoneId }
}

export default registerDomain
