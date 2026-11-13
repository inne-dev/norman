# Public Windows code signing from Russia

**Checked: 2026-11-13**

## Findings

For an individual physically resident in Russia, with no foreign residence or legal entity, the official sources reviewed do **not** establish a currently available public-trust Authenticode certificate path. This is not a claim that no CA anywhere can issue one; eligibility must be confirmed by the issuing CA, not inferred from a reseller or generic product page.

| Provider | What its official source confirms | Assessment |
|---|---|---|
| Certum | Its [2022-03-27 notice](https://www.certum.eu/en/news/change-in-the-rules-of-providing-trust-services-and-their-sale-on-the-territory-of-the-russian-federation-and-the-republic-of-belarus/) says it suspended sales of Certum services/products to Russia, including partner sales, and suspended other qualified and non-qualified certificate issuance to Russian citizens. | **Unavailable under published notice.** No official reversal found in this check. |
| DigiCert | Its [embargoed countries page](https://knowledge.digicert.com/solution/embargoed-countries-and-regions) says issuance and re-issuance of all certificate types affiliated with Russia are paused, including certificates for organizations with Russian addresses. | **Unavailable under published restriction.** |
| Sectigo | Its [Banned Country List](https://www.sectigo.com/knowledge-base/detail/Banned-Country-List-1527076085907), updated 2024-08-21, says certificates of any type cannot be issued to individuals or businesses in Russia. | **Unavailable under published restriction.** |
| GlobalSign | Its [code-signing shop](https://shop.globalsign.com/ru-ru/code-signing) says code-signing certificates are issued only to legally registered organizations. | **Not eligible as an individual without an entity.** This product condition alone does not establish a Russia-specific restriction. |
| Microsoft Artifact Signing | Microsoft’s [quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) limits public-trust individual developers to the US and Canada. | **Unavailable for a Russia-resident individual.** |
| SSL.com | SSL.com offers [individual code-signing products](https://www.ssl.com/products/software-integrity/code-signing/) without requiring a registered business. Its [CP/CPS](https://legal.ssl.com/documents/SSLcom-CP-CPS-v1.27.pdf) reserves rejection rights for applicants in countries where US law prohibits business. The public materials reviewed do not specifically confirm issuance to an individual resident in Russia. | **Unconfirmed, not established as available or categorically unavailable.** General individual eligibility is not proof of Russia eligibility. |

## PFX and key storage

An exportable `.pfx` is not a sound assumption for newly issued public code-signing certificates. SSL.com says current private keys cannot be exported as downloadable PFX and must use a hardware token, supported HSM, or its managed signing service ([current issuance guidance](https://www.ssl.com/how-to/getting-started-with-your-code-signing-certificate-installation-configuration-and-your-first-signing-operation/)). Sectigo says certificates issued since 2023-06-01 are provisioned on a hardware token or customer HSM, with compliant devices and key attestation ([Sectigo guidance](https://www.sectigo.com/enterprise-solutions/certificate-manager/code-signing-solutions)). These are provider-specific confirmations of the current hardware-backed model; they do not prove every CA offers identical delivery options. Any PR12 workflow expecting an exportable PFX should therefore be treated as incompatible with typical new issuance unless the chosen CA confirms otherwise.

## Practical next step

Ask SSL.com support in writing whether it will issue an IV code-signing certificate to a natural person whose sole residence and address are in Russia, with no foreign entity/residency, and whether its supported token or remote-signing option can be onboarded from there. Get affirmative confirmation of eligibility, payment, and delivery/onboarding before ordering. Do not treat a reseller listing or a generic “individual” product description as confirmation.

A trusted signature verifies publisher identity and that signed code has not changed; it does not certify that code is benign. Microsoft says new signed files can still receive SmartScreen warnings until reputation accumulates, and that EV no longer bypasses those warnings ([SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)). Signing cannot force antivirus or reputation systems to mark a file clean.
