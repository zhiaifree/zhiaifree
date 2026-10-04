import { onMount } from "solid-js";
import * as d3 from "d3";
import worldData from "../lib/world.json";
import chinaData from "../lib/china.json";

const GlobeComponent = () => {
  let mapContainer: HTMLDivElement | undefined;

  // 去过的国家（以后去过国外再加进来，比如 "France"）
  const visitedCountries: string[] = [];
  // 去过的省份，写简称即可（"省/市/自治区/特别行政区"后缀会自动忽略）
  const visitedProvinces = ["江苏", "河北", "陕西", "青海", "上海", "西藏", "重庆", "湖北", "湖南"];

  const normalizeName = (name: string) =>
    name.replace(/(省|市|自治区|特别行政区)$/, "");

  onMount(() => {
    if (!mapContainer) return;

    const width = mapContainer.clientWidth;
    const height = 500;
    const sensitivity = 75;

    let projection = d3
      .geoOrthographic()
      .scale(250)
      .center([0, 0])
      .rotate([-100, -35])
      .translate([width / 2, height / 2]);

    const initialScale = projection.scale();
    let pathGenerator = d3.geoPath().projection(projection);

    let svg = d3
      .select(mapContainer)
      .append("svg")
      .attr("width", width)
      .attr("height", height);

    svg
      .append("circle")
      .attr("fill", "#EEE")
      .attr("stroke", "#000")
      .attr("stroke-width", "0.2")
      .attr("cx", width / 2)
      .attr("cy", height / 2)
      .attr("r", initialScale);

    let map = svg.append("g");

    const redraw = () => {
      svg.selectAll("path").attr("d", (d: any) => pathGenerator(d as any));
    };

    // 世界各国（中国不画，下面用省份边界的详细版代替，避免两层国界线重叠）
    map
      .append("g")
      .attr("class", "countries")
      .selectAll("path")
      .data(
        (worldData.features as any[]).filter(
          (f) => f.properties.name !== "China",
        ),
      )
      .enter()
      .append("path")
      .attr("d", (d: any) => pathGenerator(d as any))
      .attr("fill", (d: { properties: { name: string } }) =>
        visitedCountries.includes(d.properties.name) ? "#E63946" : "white",
      )
      .style("stroke", "black")
      .style("stroke-width", 0.3)
      .style("opacity", 0.8);

    // 中国省份：去过的标红，其余白色并画出省界
    const provinces = (chinaData.features as any[]).filter(
      (f) => f.properties.name,
    );
    map
      .append("g")
      .attr("class", "provinces")
      .selectAll("path")
      .data(provinces)
      .enter()
      .append("path")
      .attr("d", (d: any) => pathGenerator(d))
      .attr("fill", (d: { properties: { name: string } }) =>
        visitedProvinces.includes(normalizeName(d.properties.name))
          ? "#E63946"
          : "white",
      )
      .style("stroke", "#666")
      .style("stroke-width", 0.4)
      .style("opacity", 0.8)
      .append("title")
      .text((d: { properties: { name: string } }) => d.properties.name);

    // 南海诸岛十段线
    const boundaryLines = (chinaData.features as any[]).filter(
      (f) => !f.properties.name,
    );
    map
      .append("g")
      .selectAll("path")
      .data(boundaryLines)
      .enter()
      .append("path")
      .attr("d", (d: any) => pathGenerator(d))
      .attr("fill", "none")
      .style("stroke", "#555")
      .style("stroke-width", 0.6)
      .style("opacity", 0.8);

    // 自动旋转，拖拽时暂停、松手 3 秒后恢复
    const tick = () => {
      const rotate = projection.rotate();
      const k = sensitivity / projection.scale();
      projection.rotate([rotate[0] - 1 * k, rotate[1]]);
      redraw();
    };
    let rotationTimer = d3.timer(tick, 200);

    svg
      .style("cursor", "grab")
      .call(
        d3
          .drag()
          .on("start", () => {
            rotationTimer.stop();
            svg.style("cursor", "grabbing");
          })
          .on("end", () => {
            rotationTimer = d3.timer(tick, 3000);
            svg.style("cursor", "grab");
          })
          .on("drag", (event: any) => {
            const k = sensitivity / projection.scale();
            const [lon, lat] = projection.rotate();
            projection.rotate([
              lon + event.dx * k,
              Math.max(-90, Math.min(90, lat - event.dy * k)),
              0,
            ]);
            redraw();
          }),
      );
  });

  return (
    <div class="flex flex-col text-white justify-center items-center w-full h-full">
      <div class="w-full" ref={mapContainer}></div>
    </div>
  );
};

export default GlobeComponent;
