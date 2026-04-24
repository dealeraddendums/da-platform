// Server-only: builds FTC Buyer's Guide HTML (2-page PDF) for a vehicle.
import type { BuyersGuideDefaults } from '@/lib/db';

export interface BuyersGuideInput {
  language: 'en' | 'es';
  vehicle: {
    make: string | null;
    model: string | null;
    year: string | null;
    vin: string | null;
  };
  dealer: {
    name: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    phone: string | null;
    email?: string | null;
  };
  warranty: BuyersGuideDefaults;
}

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function chk(checked: boolean): string {
  return checked ? '&#9746;' : '&#9744;';
}

// ── English ───────────────────────────────────────────────────────────────────

function buildEnPage1(i: BuyersGuideInput): string {
  const w = i.warranty;
  const isAsIs = w.warranty_type === 'as_is';
  const isImplied = w.warranty_type === 'implied_only';
  const isFull = w.warranty_type === 'full';
  const isLimited = w.warranty_type === 'limited';
  const hasWarranty = isFull || isLimited;

  const dealerLine = [i.dealer.name, i.dealer.address, [i.dealer.city, i.dealer.state, i.dealer.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(' | ');

  return `
    <div class="section" style="border:2px solid #000;padding:6px 8px;margin-bottom:6px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="font-size:11px;font-weight:700;border:1px solid #000;padding:3px 5px;">MAKE</td>
          <td style="font-size:11px;border:1px solid #000;padding:3px 5px;">${esc(i.vehicle.make)}</td>
          <td style="font-size:11px;font-weight:700;border:1px solid #000;padding:3px 5px;">MODEL</td>
          <td style="font-size:11px;border:1px solid #000;padding:3px 5px;">${esc(i.vehicle.model)}</td>
          <td style="font-size:11px;font-weight:700;border:1px solid #000;padding:3px 5px;">YEAR</td>
          <td style="font-size:11px;border:1px solid #000;padding:3px 5px;">${esc(i.vehicle.year)}</td>
          <td style="font-size:11px;font-weight:700;border:1px solid #000;padding:3px 5px;white-space:nowrap;">VIN NUMBER</td>
          <td style="font-size:11px;border:1px solid #000;padding:3px 5px;font-family:monospace;">${esc(i.vehicle.vin)}</td>
        </tr>
      </table>
    </div>

    <div style="margin-bottom:6px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:2px;margin-bottom:5px;">WARRANTIES FOR THIS VEHICLE:</div>

      <div style="margin-bottom:6px;padding-left:4px;">
        <div style="font-size:11px;font-weight:700;">${chk(isAsIs)} AS IS — NO DEALER WARRANTY</div>
        <div style="font-size:9.5px;padding:2px 0 0 20px;line-height:1.4;">
          THE DEALER DOES NOT PROVIDE A WARRANTY FOR ANY REPAIRS AFTER SALE. THE DEALER DISCLAIMS ALL
          WARRANTIES, EXPRESS OR IMPLIED. SEE THE BACK OF THIS FORM FOR AN EXPLANATION OF YOUR STATE'S
          LAW ON IMPLIED WARRANTIES.
        </div>
      </div>

      <div style="margin-bottom:6px;padding-left:4px;">
        <div style="font-size:11px;font-weight:700;">${chk(isImplied)} IMPLIED WARRANTIES ONLY</div>
        <div style="font-size:9.5px;padding:2px 0 0 20px;line-height:1.4;">
          This means implied warranties under your state's laws govern this sale. There is no implied
          warranty of merchantability or fitness for a particular purpose. See the back of this form
          for a full explanation.
        </div>
      </div>

      <div style="padding-left:4px;">
        <div style="font-size:11px;font-weight:700;">${chk(hasWarranty)} DEALER WARRANTY</div>
        <div style="padding-left:20px;margin-top:3px;">
          <div style="font-size:10px;">${chk(isFull)} FULL WARRANTY</div>
          <div style="font-size:10px;margin-top:2px;">
            ${chk(isLimited)} LIMITED WARRANTY. The dealer will pay&nbsp;
            <span style="font-weight:700;text-decoration:underline;">&nbsp;${esc(String(w.labor_pct ?? '___'))}&nbsp;</span>%
            of the labor and&nbsp;
            <span style="font-weight:700;text-decoration:underline;">&nbsp;${esc(String(w.parts_pct ?? '___'))}&nbsp;</span>%
            of the parts for the covered systems that fail during the warranty period. Ask the dealer for a copy of the
            warranty document for full details on warranty coverage, exclusions, and the dealer's repair obligations.
            Under state law, "implied warranties" may give you even more rights.
          </div>
          ${isLimited ? `
          <table style="width:100%;border-collapse:collapse;margin-top:5px;border:1px solid #000;">
            <tr>
              <td style="font-size:10px;font-weight:700;padding:3px 6px;border-right:1px solid #000;width:50%;">
                SYSTEMS COVERED:<br>
                <span style="font-weight:400;">${esc(w.systems_covered ?? '')}</span>
              </td>
              <td style="font-size:10px;font-weight:700;padding:3px 6px;">
                DURATION:<br>
                <span style="font-weight:400;">${esc(w.duration ?? '')}</span>
              </td>
            </tr>
          </table>` : `
          <table style="width:100%;border-collapse:collapse;margin-top:5px;border:1px solid #000;">
            <tr>
              <td style="font-size:10px;font-weight:700;padding:3px 6px;border-right:1px solid #000;width:50%;">SYSTEMS COVERED:</td>
              <td style="font-size:10px;font-weight:700;padding:3px 6px;">DURATION:</td>
            </tr>
          </table>`}
        </div>
      </div>
    </div>

    <div style="border:1px solid #000;padding:5px 8px;margin-bottom:6px;">
      <div style="font-size:10px;font-weight:700;margin-bottom:3px;">NON-DEALER WARRANTIES</div>
      <div style="font-size:9.5px;margin-bottom:2px;">
        ${chk(w.non_dealer_warranties?.includes('mfr_new') ?? false)} The manufacturer's new vehicle warranty still applies.
      </div>
      <div style="font-size:9.5px;margin-bottom:2px;">
        ${chk(w.non_dealer_warranties?.includes('mfr_used') ?? false)} The manufacturer's used vehicle warranty applies.
      </div>
      <div style="font-size:9.5px;">
        ${chk(w.non_dealer_warranties?.includes('other_used') ?? false)} Other used vehicle warranty applies. ____________________________
      </div>
    </div>

    <div style="font-size:9px;margin-bottom:4px;line-height:1.4;">
      <strong>SERVICE CONTRACT.</strong> A service contract is available at an extra charge on this vehicle.
      ${w.service_contract ? 'Ask for details.' : 'Ask the dealer if a service contract is available and for its terms and conditions.'}
      A service contract is a type of insurance coverage and requires separate disclosure.
    </div>

    <div style="font-size:9px;margin-bottom:4px;line-height:1.4;">
      <strong>PRE-PURCHASE INSPECTION.</strong> Ask the dealer if you may have this vehicle inspected by your
      mechanic either on or off the lot.
    </div>

    <div style="font-size:9px;margin-bottom:6px;line-height:1.4;font-weight:700;text-align:center;">
      SEE THE BACK OF THIS FORM for important additional information, including a list of the
      major defects that may occur in used motor vehicles.
    </div>

    <div style="border:1px solid #000;padding:4px 8px;margin-bottom:5px;display:flex;gap:12px;">
      <div style="flex:1;font-size:9.5px;line-height:1.6;">
        <div><strong>NAME:</strong> ${esc(i.dealer.name)}</div>
        <div><strong>ADDRESS:</strong> ${esc([i.dealer.address, i.dealer.city, i.dealer.state, i.dealer.zip].filter(Boolean).join(', '))}</div>
        <div><strong>TELEPHONE:</strong> ${esc(i.dealer.phone)}</div>
        <div><strong>EMAIL:</strong> ${esc(i.dealer.email ?? '')}</div>
      </div>
    </div>

    <div style="border:2px solid #000;padding:4px 8px;font-size:9px;line-height:1.4;background:#f8f8f8;">
      <strong>IMPORTANT:</strong> The information on this form is part of any contract to buy this vehicle.
      Removing this label before consumer purchase (except for purpose of test-driving) violates federal law
      (16 C.F.R. 455).
    </div>

    <div style="margin-top:4px;font-size:8px;font-style:italic;text-align:center;color:#333;">
      Si el concesionario gestiona la venta en español, se le debe proveer una Guía del Comprador en español.
    </div>
  `;
}

function buildEnPage2(): string {
  return `
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;text-align:center;border-bottom:2px solid #000;padding-bottom:4px;margin-bottom:8px;">
      MAJOR DEFECTS THAT MAY OCCUR IN USED MOTOR VEHICLES
    </div>
    <div style="font-size:8.5px;text-align:center;margin-bottom:8px;font-style:italic;">
      The following is a list of some major defects that may occur in used motor vehicles.
    </div>
    <div style="display:flex;gap:16px;font-size:9px;line-height:1.4;">
      <div style="flex:1;">
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">ENGINE</div>
        <div style="margin-bottom:6px;color:#222;">
          Cooling system — radiator, hoses, water pump, thermostat.<br>
          Lubrication system — oil pump, pans, gaskets, seals.<br>
          Engine block, cylinder heads, turbocharger/supercharger.<br>
          Pistons, rings, connecting rods, crankshaft and main bearings.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">TRANSMISSION / TRANSAXLE</div>
        <div style="margin-bottom:6px;color:#222;">
          Automatic or standard transmission — gears, clutches, bands, torque converters,
          shafts, housings, seals and gaskets.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">DRIVE AXLE</div>
        <div style="margin-bottom:6px;color:#222;">
          Front and/or rear drive axle assemblies — drive shafts and universal joints,
          axle shafts and bearings, front-wheel-drive half shafts.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">SUSPENSION</div>
        <div style="margin-bottom:6px;color:#222;">
          Springs and torsion bars, shock absorbers, MacPherson struts,
          ball joints, king pins, wheel bearings, stabilizer bars.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">BRAKES</div>
        <div style="margin-bottom:6px;color:#222;">
          Master cylinder, power assist booster, wheel cylinders and calipers.
          Disc/drums, hoses/lines, anti-lock braking system components.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">STEERING</div>
        <div style="margin-bottom:6px;color:#222;">
          Steering gear (rack-and-pinion or gear box), power steering pump,
          couplings, idler arm, pitman arm, tie rods.
        </div>
      </div>
      <div style="flex:1;">
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">ELECTRICAL SYSTEM</div>
        <div style="margin-bottom:6px;color:#222;">
          Alternator, generator, starter motor. Battery, ignition system,
          wiring harnesses, switches.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">AIR CONDITIONING / HEATING</div>
        <div style="margin-bottom:6px;color:#222;">
          Compressor, condenser, evaporator, heater core,
          blower motors, controls.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">EXHAUST SYSTEM</div>
        <div style="margin-bottom:6px;color:#222;">
          Manifold, muffler, catalytic converter, tailpipe, hangers.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">BODY</div>
        <div style="margin-bottom:6px;color:#222;">
          Rust, frame and structural components. Doors, hood, trunk lid,
          glass, mirrors, paint.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">SAFETY RESTRAINTS</div>
        <div style="margin-bottom:6px;color:#222;">
          Seat belts — buckles, retractors, bolts.
          Air bags — sensors, modules, steering wheel.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">FUEL SYSTEM</div>
        <div style="color:#222;">
          Fuel pump, injection system, carburetor, fuel tank,
          lines and hoses.
        </div>
      </div>
    </div>
    <div style="margin-top:16px;border-top:1px solid #000;padding-top:6px;font-size:8.5px;line-height:1.5;color:#333;">
      <strong>STATE LAWS.</strong> State lemon laws may give you additional rights. Contact your state attorney
      general or consumer protection office for information.
    </div>
  `;
}

// ── Spanish ───────────────────────────────────────────────────────────────────

function buildEsPage1(i: BuyersGuideInput): string {
  const w = i.warranty;
  const isAsIs = w.warranty_type === 'as_is';
  const isImplied = w.warranty_type === 'implied_only';
  const isFull = w.warranty_type === 'full';
  const isLimited = w.warranty_type === 'limited';
  const hasWarranty = isFull || isLimited;

  return `
    <div class="section" style="border:2px solid #000;padding:6px 8px;margin-bottom:6px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="font-size:11px;font-weight:700;border:1px solid #000;padding:3px 5px;">MARCA</td>
          <td style="font-size:11px;border:1px solid #000;padding:3px 5px;">${esc(i.vehicle.make)}</td>
          <td style="font-size:11px;font-weight:700;border:1px solid #000;padding:3px 5px;">MODELO</td>
          <td style="font-size:11px;border:1px solid #000;padding:3px 5px;">${esc(i.vehicle.model)}</td>
          <td style="font-size:11px;font-weight:700;border:1px solid #000;padding:3px 5px;">AÑO</td>
          <td style="font-size:11px;border:1px solid #000;padding:3px 5px;">${esc(i.vehicle.year)}</td>
          <td style="font-size:11px;font-weight:700;border:1px solid #000;padding:3px 5px;white-space:nowrap;">NÚMERO VIN</td>
          <td style="font-size:11px;border:1px solid #000;padding:3px 5px;font-family:monospace;">${esc(i.vehicle.vin)}</td>
        </tr>
      </table>
    </div>

    <div style="margin-bottom:6px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:2px;margin-bottom:5px;">GARANTÍAS PARA ESTE VEHÍCULO:</div>

      <div style="margin-bottom:6px;padding-left:4px;">
        <div style="font-size:11px;font-weight:700;">${chk(isAsIs)} TAL COMO ESTÁ — SIN GARANTÍA DEL CONCESIONARIO</div>
        <div style="font-size:9.5px;padding:2px 0 0 20px;line-height:1.4;">
          EL CONCESIONARIO NO OFRECE GARANTÍA ALGUNA POR LAS REPARACIONES DESPUÉS DE LA VENTA. EL CONCESIONARIO
          RECHAZA TODA GARANTÍA EXPRESA O IMPLÍCITA. CONSULTE EL REVERSO DE ESTE FORMULARIO PARA OBTENER UNA
          EXPLICACIÓN DE LAS LEYES DE SU ESTADO SOBRE GARANTÍAS IMPLÍCITAS.
        </div>
      </div>

      <div style="margin-bottom:6px;padding-left:4px;">
        <div style="font-size:11px;font-weight:700;">${chk(isImplied)} SÓLO GARANTÍAS IMPLÍCITAS</div>
        <div style="font-size:9.5px;padding:2px 0 0 20px;line-height:1.4;">
          Esto significa que las garantías implícitas de las leyes de su estado rigen esta venta.
          No existe garantía implícita de comerciabilidad ni de idoneidad para un propósito particular.
          Consulte el reverso de este formulario para una explicación completa.
        </div>
      </div>

      <div style="padding-left:4px;">
        <div style="font-size:11px;font-weight:700;">${chk(hasWarranty)} GARANTÍA DEL CONCESIONARIO</div>
        <div style="padding-left:20px;margin-top:3px;">
          <div style="font-size:10px;">${chk(isFull)} GARANTÍA TOTAL</div>
          <div style="font-size:10px;margin-top:2px;">
            ${chk(isLimited)} GARANTÍA LIMITADA. El concesionario pagará&nbsp;
            <span style="font-weight:700;text-decoration:underline;">&nbsp;${esc(String(w.labor_pct ?? '___'))}&nbsp;</span>%
            de la mano de obra y&nbsp;
            <span style="font-weight:700;text-decoration:underline;">&nbsp;${esc(String(w.parts_pct ?? '___'))}&nbsp;</span>%
            de las piezas por los sistemas cubiertos que fallen durante el período de garantía. Solicite al
            concesionario una copia del documento de garantía para obtener información completa sobre la cobertura,
            exclusiones y las obligaciones de reparación del concesionario.
          </div>
          ${isLimited ? `
          <table style="width:100%;border-collapse:collapse;margin-top:5px;border:1px solid #000;">
            <tr>
              <td style="font-size:10px;font-weight:700;padding:3px 6px;border-right:1px solid #000;width:50%;">
                SISTEMAS CUBIERTOS:<br>
                <span style="font-weight:400;">${esc(w.systems_covered ?? '')}</span>
              </td>
              <td style="font-size:10px;font-weight:700;padding:3px 6px;">
                DURACIÓN:<br>
                <span style="font-weight:400;">${esc(w.duration ?? '')}</span>
              </td>
            </tr>
          </table>` : `
          <table style="width:100%;border-collapse:collapse;margin-top:5px;border:1px solid #000;">
            <tr>
              <td style="font-size:10px;font-weight:700;padding:3px 6px;border-right:1px solid #000;width:50%;">SISTEMAS CUBIERTOS:</td>
              <td style="font-size:10px;font-weight:700;padding:3px 6px;">DURACIÓN:</td>
            </tr>
          </table>`}
        </div>
      </div>
    </div>

    <div style="border:1px solid #000;padding:5px 8px;margin-bottom:6px;">
      <div style="font-size:10px;font-weight:700;margin-bottom:3px;">GARANTÍAS DE TERCEROS</div>
      <div style="font-size:9.5px;margin-bottom:2px;">
        ${chk(w.non_dealer_warranties?.includes('mfr_new') ?? false)} Todavía se aplica la garantía de vehículo nuevo del fabricante.
      </div>
      <div style="font-size:9.5px;margin-bottom:2px;">
        ${chk(w.non_dealer_warranties?.includes('mfr_used') ?? false)} Se aplica la garantía de vehículo usado del fabricante.
      </div>
      <div style="font-size:9.5px;">
        ${chk(w.non_dealer_warranties?.includes('other_used') ?? false)} Se aplica otra garantía de vehículo usado. ____________________________
      </div>
    </div>

    <div style="font-size:9px;margin-bottom:4px;line-height:1.4;">
      <strong>CONTRATO DE SERVICIO.</strong> Hay un contrato de servicio disponible a un cargo adicional para
      este vehículo. Solicite los detalles.
    </div>

    <div style="font-size:9px;margin-bottom:4px;line-height:1.4;">
      <strong>INSPECCIÓN PREVIA A LA COMPRA.</strong> Pregunte al concesionario si puede hacer que su mecánico
      inspeccione este vehículo, ya sea dentro o fuera del establecimiento.
    </div>

    <div style="font-size:9px;margin-bottom:6px;line-height:1.4;font-weight:700;text-align:center;">
      VEA EL REVERSO DE ESTE FORMULARIO para información adicional importante, incluyendo una lista de los
      defectos más importantes que pueden ocurrir en los vehículos de motor usados.
    </div>

    <div style="border:1px solid #000;padding:4px 8px;margin-bottom:5px;">
      <div style="font-size:9.5px;line-height:1.6;">
        <div><strong>NOMBRE:</strong> ${esc(i.dealer.name)}</div>
        <div><strong>DIRECCIÓN:</strong> ${esc([i.dealer.address, i.dealer.city, i.dealer.state, i.dealer.zip].filter(Boolean).join(', '))}</div>
        <div><strong>TELÉFONO:</strong> ${esc(i.dealer.phone)}</div>
        <div><strong>CORREO ELECTRÓNICO:</strong> ${esc(i.dealer.email ?? '')}</div>
      </div>
    </div>

    <div style="border:2px solid #000;padding:4px 8px;font-size:9px;line-height:1.4;background:#f8f8f8;">
      <strong>IMPORTANTE:</strong> La información de este formulario forma parte de cualquier contrato para
      comprar este vehículo. Retirar esta etiqueta antes de la compra del consumidor (excepto con el propósito
      de hacer una prueba de manejo) viola la ley federal (16 C.F.R. 455).
    </div>
  `;
}

function buildEsPage2(): string {
  return `
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;text-align:center;border-bottom:2px solid #000;padding-bottom:4px;margin-bottom:8px;">
      DEFECTOS PRINCIPALES QUE PUEDEN OCURRIR EN VEHÍCULOS DE MOTOR USADOS
    </div>
    <div style="font-size:8.5px;text-align:center;margin-bottom:8px;font-style:italic;">
      A continuación se presenta una lista de algunos de los defectos más importantes que pueden ocurrir en vehículos usados.
    </div>
    <div style="display:flex;gap:16px;font-size:9px;line-height:1.4;">
      <div style="flex:1;">
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">MOTOR</div>
        <div style="margin-bottom:6px;color:#222;">
          Sistema de enfriamiento — radiador, mangueras, bomba de agua, termostato.<br>
          Sistema de lubricación — bomba de aceite, cárter, juntas, sellos.<br>
          Bloque del motor, culatas, turbocompresor/sobrealimentador.<br>
          Pistones, anillos, bielas, cigüeñal y cojinetes principales.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">TRANSMISIÓN / TRANSEJE</div>
        <div style="margin-bottom:6px;color:#222;">
          Transmisión automática o manual — engranajes, embragues, bandas, convertidores de par,
          ejes, carcasas, sellos y juntas.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">EJE DE TRACCIÓN</div>
        <div style="margin-bottom:6px;color:#222;">
          Conjuntos del eje de tracción delantero y/o trasero — cardanes y juntas universales,
          semiejes y rodamientos, semiejes de tracción delantera.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">SUSPENSIÓN</div>
        <div style="margin-bottom:6px;color:#222;">
          Resortes y barras de torsión, amortiguadores, puntales MacPherson,
          rótulas, pernos de dirección, cojinetes de rueda, barras estabilizadoras.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">FRENOS</div>
        <div style="margin-bottom:6px;color:#222;">
          Cilindro maestro, servofreno, cilindros de rueda y calibradores.
          Discos/tambores, mangueras/líneas, componentes del sistema ABS.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">DIRECCIÓN</div>
        <div style="margin-bottom:6px;color:#222;">
          Caja de dirección (cremallera y piñón o caja de engranajes), bomba de dirección asistida,
          acoplamientos, brazo pendular, brazo Pitman, rótulas de dirección.
        </div>
      </div>
      <div style="flex:1;">
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">SISTEMA ELÉCTRICO</div>
        <div style="margin-bottom:6px;color:#222;">
          Alternador, generador, motor de arranque. Batería, sistema de encendido,
          arneses de cableado, interruptores.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">AIRE ACONDICIONADO / CALEFACCIÓN</div>
        <div style="margin-bottom:6px;color:#222;">
          Compresor, condensador, evaporador, núcleo del calefactor,
          motores de ventilación, controles.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">SISTEMA DE ESCAPE</div>
        <div style="margin-bottom:6px;color:#222;">
          Múltiple, silenciador, convertidor catalítico, tubo de escape, soportes.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">CARROCERÍA</div>
        <div style="margin-bottom:6px;color:#222;">
          Óxido, chasis y componentes estructurales. Puertas, capó, tapa del maletero,
          vidrios, espejos, pintura.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">SISTEMAS DE SEGURIDAD</div>
        <div style="margin-bottom:6px;color:#222;">
          Cinturones de seguridad — hebillas, retractores, pernos.
          Bolsas de aire — sensores, módulos, volante.
        </div>
        <div style="font-weight:700;text-decoration:underline;margin-bottom:3px;">SISTEMA DE COMBUSTIBLE</div>
        <div style="color:#222;">
          Bomba de combustible, sistema de inyección, carburador,
          depósito de combustible, líneas y mangueras.
        </div>
      </div>
    </div>
    <div style="margin-top:16px;border-top:1px solid #000;padding-top:6px;font-size:8.5px;line-height:1.5;color:#333;">
      <strong>LEYES ESTATALES.</strong> Las leyes de limón de su estado pueden otorgarle derechos adicionales.
      Comuníquese con el fiscal general de su estado u oficina de protección al consumidor.
    </div>
  `;
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildBuyersGuideHtml(input: BuyersGuideInput): string {
  const en = input.language === 'en';
  const title = en ? 'BUYERS GUIDE' : 'GUÍA DEL COMPRADOR';
  const subtitle = en
    ? 'IMPORTANT: Spoken promises are difficult to enforce. Ask the dealer to put all promises in writing. Keep this form.'
    : 'IMPORTANTE: Las promesas verbales son difíciles de hacer cumplir. Pídale al concesionario que ponga todas las promesas por escrito. Guarde este formulario.';
  const page1 = en ? buildEnPage1(input) : buildEsPage1(input);
  const page2 = en ? buildEnPage2() : buildEsPage2();

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 816px; font-family: Arial, 'Times New Roman', sans-serif; background: #fff; }
.page {
  width: 816px;
  height: 1056px;
  overflow: hidden;
  padding: 36px 48px;
  box-sizing: border-box;
  page-break-after: always;
}
.page:last-child { page-break-after: auto; }
</style>
</head>
<body>

<div class="page">
  <div style="text-align:center;margin-bottom:6px;">
    <div style="font-size:22px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${title}</div>
  </div>
  <div style="font-size:9px;font-style:italic;margin-bottom:8px;line-height:1.4;text-align:center;padding:0 20px;">
    ${subtitle}
  </div>
  ${page1}
</div>

<div class="page">
  ${page2}
</div>

</body>
</html>`;
}
