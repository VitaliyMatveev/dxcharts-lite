/*
 * Copyright (C) 2019 - 2023 Devexperts Solutions IE Limited
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { Subject } from 'rxjs';
import { CanvasAnimation } from '../../animation/canvas-animation';
import { CHART_UUID, CanvasBoundsContainer, CanvasElement } from '../../canvas/canvas-bounds-container';
import { CursorHandler } from '../../canvas/cursor.handler';
import { FullChartConfig } from '../../chart.config';
import { DrawingManager } from '../../drawers/drawing-manager';
import EventBus from '../../events/event-bus';
import { CrossEventProducerComponent } from '../../inputhandlers/cross-event-producer.component';
import { CanvasInputListenerComponent, Point } from '../../inputlisteners/canvas-input-listener.component';
import { CanvasModel } from '../../model/canvas.model';
import { ChartBaseElement, ChartEntity } from '../../model/chart-base-element';
import { ScaleModel } from '../../model/scale.model';
import { AtLeastOne } from '../../utils/object.utils';
import { uuid as generateUuid } from '../../utils/uuid.utils';
import { ChartBaseModel } from '../chart/chart-base.model';
import { createHighLowOffsetCalculator } from '../chart/data-series.high-low-provider';
import { ChartPanComponent } from '../pan/chart-pan.component';
import { BarResizerComponent } from '../resizer/bar-resizer.component';
import {
	YExtentComponent,
	YExtentCreationOptions,
	createDefaultYExtentHighLowProvider,
} from './extent/y-extent-component';
import { PaneHitTestController } from './pane-hit-test.controller';
import { PaneComponent } from './pane.component';
import { Unsubscriber } from '../../utils/function.utils';
import { flatMap } from '../../utils/array.utils';
import { DataSeriesModel } from '../../model/data-series.model';

export class PaneManager extends ChartBaseElement {
	public panes: Record<string, PaneComponent> = {};
	public paneRemovedSubject: Subject<PaneComponent> = new Subject();
	public paneAddedSubject: Subject<Record<string, PaneComponent>> = new Subject();
	public hitTestController: PaneHitTestController;
	public dataSeriesAddedSubject: Subject<DataSeriesModel> = new Subject();
	public dataSeriesRemovedSubject: Subject<DataSeriesModel> = new Subject();
	/**
	 * Returns order of panes in the chart from top to bottom.
	 */
	public get panesOrder() {
		return this.canvasBoundsContainer.panesOrder;
	}
	constructor(
		private chartBaseModel: ChartBaseModel<'candle'>,
		private dynamicObjectsCanvasModel: CanvasModel,
		private userInputListenerComponents: ChartEntity[],
		private eventBus: EventBus,
		private mainScale: ScaleModel,
		private canvasBoundsContainer: CanvasBoundsContainer,
		private config: FullChartConfig,
		private canvasAnimation: CanvasAnimation,
		private canvasInputListener: CanvasInputListenerComponent,
		private drawingManager: DrawingManager,
		private cursorHandler: CursorHandler,
		private crossEventProducer: CrossEventProducerComponent,
		public chartPanComponent: ChartPanComponent,
		private mainCanvasModel: CanvasModel,
		private yAxisLabelsCanvasModel: CanvasModel,
	) {
		super();
		this.hitTestController = new PaneHitTestController(this.panes, this.dynamicObjectsCanvasModel);

		const mainPane = this.createPane(CHART_UUID, {
			useDefaultHighLow: false,
			scale: this.mainScale,
		});
		mainPane.mainExtent.scale.autoScaleModel.setHighLowProvider(
			'series',
			createDefaultYExtentHighLowProvider(mainPane.mainExtent),
		);
		mainScale.autoScaleModel.setHighLowPostProcessor(
			'offsets',
			createHighLowOffsetCalculator(() => this.mainScale.getOffsets()),
		);
	}

	private addBounds(uuid: string, order?: number): Unsubscriber {
		this.canvasBoundsContainer.addPaneBounds(uuid, order);
		return () => this.canvasBoundsContainer.removedPaneBounds(uuid);
	}

	/**
	 * Adds a resizer to the canvas bounds container for the given uuid.
	 * @param {string} uuid - The uuid of the pane to which the resizer is to be added.
	 * @returns {BarResizerComponent} - The BarResizerComponent instance that was added to the userInputListenerComponents array.
	 */
	private addResizer(uuid: string) {
		const resizerHT = this.canvasBoundsContainer.getBoundsHitTest(CanvasElement.PANE_UUID_RESIZER(uuid), {
			extensionY: this.config.components.paneResizer.dragZone,
		});
		const dragTick = () => {
			this.canvasBoundsContainer.resizePaneVertically(uuid, this.canvasInputListener.getCurrentPoint().y);
			this.eventBus.fireDraw([this.mainCanvasModel.canvasId, 'dynamicObjectsCanvas']);
		};
		const resizerId = CanvasElement.PANE_UUID_RESIZER(uuid);
		const barResizerComponent = new BarResizerComponent(
			resizerId,
			() => this.canvasBoundsContainer.getBounds(resizerId),
			resizerHT,
			dragTick,
			this.chartPanComponent,
			this.mainCanvasModel,
			this.drawingManager,
			this.canvasInputListener,
			this.canvasAnimation,
			this.config,
			this.canvasBoundsContainer,
		);
		this.userInputListenerComponents.push(barResizerComponent);
		return barResizerComponent;
	}

	get yExtents(): YExtentComponent[] {
		return flatMap(Object.values(this.panes), c => c.yExtentComponents);
	}

	/**
	 * Returns the pane component that contains the given point.
	 * @param {Point} point - The point to check.
	 * @returns {PaneComponent | undefined} - The pane component that contains the point or undefined if no pane contains it.
	 */
	public getPaneIfHit(point: Point): PaneComponent | undefined {
		const panes = Object.values(this.panes);
		return panes.find(p =>
			this.canvasBoundsContainer.getBoundsHitTest(CanvasElement.PANE_UUID(p.uuid))(point.x, point.y),
		);
	}

	/**
	 * Creates sub-plot on the chart with y-axis
	 * @param uuid
	 * @returns
	 */
	public createPane(uuid = generateUuid(), options?: AtLeastOne<YExtentCreationOptions>): PaneComponent {
		if (this.panes[uuid] !== undefined) {
			return this.panes[uuid];
		}

		const paneComponent: PaneComponent = new PaneComponent(
			this.chartBaseModel,
			this.mainCanvasModel,
			this.yAxisLabelsCanvasModel,
			this.dynamicObjectsCanvasModel,
			this.hitTestController,
			this.config,
			this.mainScale,
			this.drawingManager,
			this.chartPanComponent,
			this.canvasInputListener,
			this.canvasAnimation,
			this.cursorHandler,
			this.eventBus,
			this.canvasBoundsContainer,
			uuid,
			this.dataSeriesAddedSubject,
			this.dataSeriesRemovedSubject,
			options,
		);

		// TODO: is resizer should be added always?
		if (this.config.components.paneResizer.visible) {
			paneComponent.addChildEntity(this.addResizer(uuid));
		}

		paneComponent.addSubscription(this.addBounds(uuid, options?.order));
		paneComponent.addSubscription(this.addCursors(uuid));
		paneComponent.addSubscription(this.crossEventProducer.subscribeMouseOverHT(uuid, paneComponent.ht));

		this.panes[uuid] = paneComponent;
		paneComponent.activate();
		this.recalculateState();
		paneComponent.mainExtent.scale.autoScale(true);
		this.paneAddedSubject.next(this.panes);
		return paneComponent;
	}

	/**
	 * Removes pane from the chart and all related components
	 * @param uuid
	 */
	public removePane(uuid: string) {
		const pane = this.panes[uuid];
		if (pane !== undefined) {
			this.paneRemovedSubject.next(pane);
			pane.disable();
			pane.yExtentComponents.forEach(yExtentComponent => yExtentComponent.disable());
			delete this.panes[uuid];
			this.recalculateState();
		}
	}

	/**
	 * Adds cursors to the chart elements based on the provided uuid and cursor type.
	 * @private
	 * @param {string} uuid - The unique identifier for the chart element.
	 * @param {string} [cursor=this.config.components.chart.cursor] - The type of cursor to be added to the chart element.
	 * @returns {void}
	 */
	private addCursors(uuid: string, cursor: string = this.config.components.chart.cursor) {
		const pane = CanvasElement.PANE_UUID(uuid);
		const paneResizer = CanvasElement.PANE_UUID_RESIZER(uuid);

		this.cursorHandler.setCursorForCanvasEl(pane, cursor);
		this.config.components.paneResizer.visible &&
			this.cursorHandler.setCursorForCanvasEl(
				paneResizer,
				this.config.components.paneResizer.cursor,
				this.config.components.paneResizer.dragZone,
			);

		return () => {
			this.cursorHandler.removeCursorForCanvasEl(pane);
			this.config.components.paneResizer.visible && this.cursorHandler.removeCursorForCanvasEl(paneResizer);
		};
	}

	/**
	 * Recalculates the zoom Y of all pane components and fires a draw event on the event bus.
	 * @function
	 * @name recalculateState
	 * @memberof PaneManager
	 * @returns {void}
	 */
	public recalculateState() {
		Object.values(this.panes).forEach(state => state.scale.recalculateZoomY());
		this.eventBus.fireDraw([this.mainCanvasModel.canvasId, 'dynamicObjectsCanvas']);
	}
}
